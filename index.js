// Load environment variables
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Middleware
app.use(express.json());
app.use(cors());

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => console.log("MongoDB connected"))
  .catch(err => console.error("MongoDB connection error:", err));

// User Schema
const UserSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  number: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  userType: { type: String, enum: ["ambulance", "client", "admin", "hospital"], default: "client" },
  lastLogin: { type: Date, default: null },
  status: { type: String, enum: ["online", "offline", "busy"], default: "offline" }
});

const User = mongoose.model("User", UserSchema);

// Ambulance Schema
const AmbulanceSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  vehicleId: { type: String, required: true, unique: true },
  vehicleType: { type: String, enum: ["basic", "advanced", "critical"], default: "basic" },
  currentLocation: {
    latitude: { type: Number, default: null },
    longitude: { type: Number, default: null },
    lastUpdated: { type: Date, default: null }
  },
  status: { type: String, enum: ["available", "on_route", "with_patient", "at_hospital", "offline"], default: "offline" }
});

const Ambulance = mongoose.model("Ambulance", AmbulanceSchema);

// Emergency Request Schema
const EmergencyRequestSchema = new mongoose.Schema({
  requesterId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  location: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
    address: { type: String }
  },
  ambulanceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ambulance' },
  status: { type: String, enum: ["pending", "accepted", "in_progress", "completed", "cancelled"], default: "pending" },
  emergencyDetails: { type: String },
  patientCount: { type: Number, default: 1 },
  criticalLevel: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
  createdAt: { type: Date, default: Date.now },
  completedAt: { type: Date }
});

const EmergencyRequest = mongoose.model("EmergencyRequest", EmergencyRequestSchema);

// Store ambulance locations and socket mappings
const onlineAmbulances = {};
const userSocketMap = {};

io.on("connection", (socket) => {
  console.log("A user connected:", socket.id);

  // Authenticate socket connection
  socket.on("authenticate", async ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      
      if (user) {
        // Map socket ID to user ID for future reference
        userSocketMap[socket.id] = {
          userId: user._id,
          userType: user.userType
        };
        
        socket.emit("authenticated", { success: true });
        console.log(`User ${user._id} authenticated as ${user.userType}`);
      } else {
        socket.emit("authenticated", { success: false, message: "Invalid user" });
      }
    } catch (error) {
      socket.emit("authenticated", { success: false, message: "Authentication failed" });
    }
  });

  // Ambulance going online
  socket.on("ambulanceOnline", async ({ token }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      
      if (user && user.userType === "ambulance") {
        // Update user status
        user.status = "online";
        await user.save();
        
        // Find or create ambulance record
        let ambulance = await Ambulance.findOne({ userId: user._id });
        if (!ambulance) {
          // If ambulance record doesn't exist, handle appropriately
          socket.emit("error", { message: "Ambulance record not found" });
          return;
        }
        
        ambulance.status = "available";
        await ambulance.save();
        
        // Add to online ambulances mapping
        onlineAmbulances[user._id.toString()] = {
          socketId: socket.id,
          ambulanceId: ambulance._id,
          vehicleType: ambulance.vehicleType,
          status: ambulance.status
        };
        
        socket.emit("statusUpdate", { status: "available" });
        
        // Broadcast to clients that a new ambulance is available
        io.emit("ambulanceStatusUpdate", {
          ambulanceId: ambulance._id,
          status: "available",
          vehicleType: ambulance.vehicleType
        });
        
        console.log(`Ambulance ${user._id} is now online`);
      }
    } catch (error) {
      console.error("Error in ambulanceOnline:", error);
      socket.emit("error", { message: "Failed to set ambulance online" });
    }
  });

  // Update ambulance location
  socket.on("updateLocation", async ({ token, latitude, longitude }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const userId = decoded.userId;
      
      // Find the ambulance by userId
      const ambulance = await Ambulance.findOne({ userId });
      
      if (ambulance) {
        // Update the location
        ambulance.currentLocation.latitude = latitude;
        ambulance.currentLocation.longitude = longitude;
        ambulance.currentLocation.lastUpdated = new Date();
        await ambulance.save();
        
        console.log(`Updated location for ambulance ${ambulance._id}: ${latitude}, ${longitude}`);
        
        // Broadcast the location update to all connected clients
        io.emit("ambulanceLocationUpdate", {
          ambulanceId: ambulance._id,
          latitude,
          longitude,
          status: ambulance.status,
          vehicleType: ambulance.vehicleType
        });
        
        // If ambulance is on a mission, send specific updates to the requester
        if (ambulance.status === "on_route" || ambulance.status === "with_patient") {
          const activeRequest = await EmergencyRequest.findOne({
            ambulanceId: ambulance._id,
            status: { $in: ["accepted", "in_progress"] }
          });
          
          if (activeRequest) {
            // Find the socket of the requester if they're online
            const requesterSocketId = Object.keys(userSocketMap).find(
              socketId => userSocketMap[socketId].userId.toString() === activeRequest.requesterId.toString()
            );
            
            if (requesterSocketId) {
              io.to(requesterSocketId).emit("assignedAmbulanceLocation", {
                requestId: activeRequest._id,
                ambulanceId: ambulance._id,
                latitude,
                longitude,
                status: ambulance.status
              });
            }
          }
        }
      }
    } catch (error) {
      console.error("Error updating location:", error);
      socket.emit("error", { message: "Failed to update location" });
    }
  });

  // Request ambulance emergency service
  socket.on("requestAmbulance", async ({ token, latitude, longitude, address, emergencyDetails, patientCount, criticalLevel }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      
      if (!user) {
        socket.emit("requestResponse", { success: false, message: "User not found" });
        return;
      }
      
      // Create a new emergency request
      const emergencyRequest = new EmergencyRequest({
        requesterId: user._id,
        location: {
          latitude,
          longitude,
          address: address || "Unknown location"
        },
        emergencyDetails: emergencyDetails || "Emergency assistance needed",
        patientCount: patientCount || 1,
        criticalLevel: criticalLevel || "medium"
      });
      
      await emergencyRequest.save();
      
      // Notify the user that their request has been received
      socket.emit("requestResponse", {
        success: true,
        message: "Emergency request received",
        requestId: emergencyRequest._id
      });
      
      console.log(`New emergency request created: ${emergencyRequest._id}`);
      
      // Find available ambulances nearby (in a real app, you'd implement distance calculation)
      const availableAmbulances = await Ambulance.find({ status: "available" });
      
      // Emit notification to all available ambulances
      availableAmbulances.forEach(ambulance => {
        const ambulanceSocketData = onlineAmbulances[ambulance.userId.toString()];
        if (ambulanceSocketData) {
          io.to(ambulanceSocketData.socketId).emit("emergencyRequest", {
            requestId: emergencyRequest._id,
            location: emergencyRequest.location,
            criticalLevel: emergencyRequest.criticalLevel,
            patientCount: emergencyRequest.patientCount,
            emergencyDetails: emergencyRequest.emergencyDetails
          });
        }
      });
    } catch (error) {
      console.error("Error requesting ambulance:", error);
      socket.emit("requestResponse", { success: false, message: "Failed to process emergency request" });
    }
  });

  // Ambulance accepting an emergency request
  socket.on("acceptEmergency", async ({ token, requestId }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      
      if (!user || user.userType !== "ambulance") {
        socket.emit("acceptResponse", { success: false, message: "Unauthorized" });
        return;
      }
      
      const ambulance = await Ambulance.findOne({ userId: user._id });
      if (!ambulance) {
        socket.emit("acceptResponse", { success: false, message: "Ambulance not found" });
        return;
      }
      
      const request = await EmergencyRequest.findById(requestId);
      if (!request) {
        socket.emit("acceptResponse", { success: false, message: "Request not found" });
        return;
      }
      
      if (request.status !== "pending") {
        socket.emit("acceptResponse", { success: false, message: "Request already processed" });
        return;
      }
      
      // Update emergency request
      request.ambulanceId = ambulance._id;
      request.status = "accepted";
      await request.save();
      
      // Update ambulance status
      ambulance.status = "on_route";
      await ambulance.save();
      
      if (onlineAmbulances[user._id.toString()]) {
        onlineAmbulances[user._id.toString()].status = "on_route";
      }
      
      // Notify ambulance driver
      socket.emit("acceptResponse", {
        success: true,
        message: "Emergency request accepted",
        requestDetails: {
          id: request._id,
          location: request.location,
          emergencyDetails: request.emergencyDetails,
          patientCount: request.patientCount,
          criticalLevel: request.criticalLevel
        }
      });
      
      // Notify the requester
      const requesterSocketId = Object.keys(userSocketMap).find(
        socketId => userSocketMap[socketId].userId.toString() === request.requesterId.toString()
      );
      
      if (requesterSocketId) {
        io.to(requesterSocketId).emit("ambulanceAssigned", {
          requestId: request._id,
          ambulanceId: ambulance._id,
          vehicleType: ambulance.vehicleType,
          currentLocation: ambulance.currentLocation
        });
      }
      
      // Broadcast ambulance status change to all clients
      io.emit("ambulanceStatusUpdate", {
        ambulanceId: ambulance._id,
        status: "on_route"
      });
      
      console.log(`Ambulance ${ambulance._id} accepted emergency request ${request._id}`);
    } catch (error) {
      console.error("Error accepting emergency:", error);
      socket.emit("acceptResponse", { success: false, message: "Failed to accept emergency request" });
    }
  });

  // Update emergency status (arrived, with_patient, at_hospital, completed)
  socket.on("updateEmergencyStatus", async ({ token, requestId, status }) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const user = await User.findById(decoded.userId);
      
      if (!user || user.userType !== "ambulance") {
        socket.emit("statusUpdateResponse", { success: false, message: "Unauthorized" });
        return;
      }
      
      const ambulance = await Ambulance.findOne({ userId: user._id });
      if (!ambulance) {
        socket.emit("statusUpdateResponse", { success: false, message: "Ambulance not found" });
        return;
      }
      
      const request = await EmergencyRequest.findById(requestId);
      if (!request || request.ambulanceId.toString() !== ambulance._id.toString()) {
        socket.emit("statusUpdateResponse", { success: false, message: "Invalid request" });
        return;
      }
      
      // Map the emergency status to ambulance status
      let ambulanceStatus;
      
      switch (status) {
        case "arrived_at_scene":
          request.status = "in_progress";
          ambulanceStatus = "with_patient";
          break;
        case "en_route_to_hospital":
          request.status = "in_progress";
          ambulanceStatus = "with_patient";
          break;
        case "arrived_at_hospital":
          request.status = "in_progress";
          ambulanceStatus = "at_hospital";
          break;
        case "completed":
          request.status = "completed";
          request.completedAt = new Date();
          ambulanceStatus = "available";
          break;
        default:
          socket.emit("statusUpdateResponse", { success: false, message: "Invalid status" });
          return;
      }
      
      // Update emergency request
      await request.save();
      
      // Update ambulance status
      ambulance.status = ambulanceStatus;
      await ambulance.save();
      
      if (onlineAmbulances[user._id.toString()]) {
        onlineAmbulances[user._id.toString()].status = ambulanceStatus;
      }
      
      // Notify ambulance driver
      socket.emit("statusUpdateResponse", {
        success: true,
        message: "Status updated successfully",
        newStatus: status
      });
      
      // Notify the requester
      const requesterSocketId = Object.keys(userSocketMap).find(
        socketId => userSocketMap[socketId].userId.toString() === request.requesterId.toString()
      );
      
      if (requesterSocketId) {
        io.to(requesterSocketId).emit("emergencyStatusUpdate", {
          requestId: request._id,
          status: status,
          ambulanceStatus: ambulanceStatus
        });
      }
      
      // Broadcast ambulance status change to all clients
      io.emit("ambulanceStatusUpdate", {
        ambulanceId: ambulance._id,
        status: ambulanceStatus
      });
      
      console.log(`Emergency request ${request._id} status updated to ${status}`);
    } catch (error) {
      console.error("Error updating emergency status:", error);
      socket.emit("statusUpdateResponse", { success: false, message: "Failed to update status" });
    }
  });

  socket.on("disconnect", async () => {
    console.log("User disconnected:", socket.id);
    
    // Check if this socket belongs to an ambulance
    if (userSocketMap[socket.id]) {
      const { userId, userType } = userSocketMap[socket.id];
      
      if (userType === "ambulance") {
        // Only update to offline if not on an active mission
        const ambulance = await Ambulance.findOne({ userId });
        
        if (ambulance && (ambulance.status === "available" || ambulance.status === "offline")) {
          ambulance.status = "offline";
          await ambulance.save();
          
          // Update the user status
          await User.findByIdAndUpdate(userId, { status: "offline" });
          
          // Remove from online ambulances
          delete onlineAmbulances[userId.toString()];
          
          // Broadcast ambulance offline status
          io.emit("ambulanceStatusUpdate", {
            ambulanceId: ambulance._id,
            status: "offline"
          });
          
          console.log(`Ambulance ${userId} set to offline`);
        }
      }
      
      // Remove socket from user mapping
      delete userSocketMap[socket.id];
    }
  });
});

// Register Route
app.post("/register", async (req, res) => {
  try {
    const { name, email, number, password, userType, vehicleId, vehicleType } = req.body;
    if (!name || !email || !number || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ message: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email, number, password: hashedPassword, userType: userType || "client" });
    await newUser.save();

    // If registering as an ambulance, create ambulance record
    if (userType === "ambulance") {
      if (!vehicleId) {
        return res.status(400).json({ message: "Vehicle ID is required for ambulance registration" });
      }
      
      const newAmbulance = new Ambulance({
        userId: newUser._id,
        vehicleId,
        vehicleType: vehicleType || "basic",
        status: "offline"
      });
      
      await newAmbulance.save();
    }

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login Route
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign({ userId: user._id, userType: user.userType }, JWT_SECRET, { expiresIn: "7d" });

    // If user is an ambulance, include ambulance details
    let ambulanceDetails = null;
    if (user.userType === "ambulance") {
      const ambulance = await Ambulance.findOne({ userId: user._id });
      if (ambulance) {
        ambulanceDetails = {
          ambulanceId: ambulance._id,
          vehicleId: ambulance.vehicleId,
          vehicleType: ambulance.vehicleType,
          status: ambulance.status
        };
      }
    }

    res.json({ token, userType: user.userType, ambulanceDetails });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get nearby ambulances
app.get("/nearby-ambulances", async (req, res) => {
  try {
    const { latitude, longitude, radius = 10 } = req.query; // radius in kilometers
    
    if (!latitude || !longitude) {
      return res.status(400).json({ message: "Latitude and longitude are required" });
    }
    
    // Find ambulances that are online or on duty
    const ambulances = await Ambulance.find({
      status: { $in: ["available", "on_route", "with_patient", "at_hospital"] },
      "currentLocation.latitude": { $ne: null },
      "currentLocation.longitude": { $ne: null }
    }).populate('userId', 'name');
    
    // In a real app, you'd implement proper distance calculation with MongoDB geospatial queries
    // This is a simplified version for demonstration purposes
    const nearbyAmbulances = ambulances.map(ambulance => ({
      id: ambulance._id,
      driverName: ambulance.userId.name,
      vehicleType: ambulance.vehicleType,
      status: ambulance.status,
      location: ambulance.currentLocation,
      // In a real app you would calculate actual distance here
      distance: "calculating..." // Placeholder
    }));
    
    res.json({ ambulances: nearbyAmbulances });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get emergency request status
app.get("/emergency-request/:requestId", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Unauthorized" });

    const decoded = jwt.verify(token, JWT_SECRET);
    const { requestId } = req.params;
    
    const request = await EmergencyRequest.findById(requestId)
      .populate({
        path: 'ambulanceId',
        select: 'vehicleId vehicleType currentLocation status',
        populate: {
          path: 'userId',
          select: 'name number'
        }
      });
    
    if (!request) {
      return res.status(404).json({ message: "Emergency request not found" });
    }
    
    // Verify the requester is authorized to see this request
    if (request.requesterId.toString() !== decoded.userId && decoded.userType !== "admin") {
      return res.status(403).json({ message: "Not authorized to view this request" });
    }
    
    res.json({
      request: {
        id: request._id,
        status: request.status,
        location: request.location,
        emergencyDetails: request.emergencyDetails,
        createdAt: request.createdAt,
        completedAt: request.completedAt,
        ambulance: request.ambulanceId ? {
          id: request.ambulanceId._id,
          vehicleId: request.ambulanceId.vehicleId,
          vehicleType: request.ambulanceId.vehicleType,
          currentLocation: request.ambulanceId.currentLocation,
          status: request.ambulanceId.status,
          driverName: request.ambulanceId.userId?.name,
          driverContact: request.ambulanceId.userId?.number
        } : null
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Verify Token Route
app.post("/verify-token", async (req, res) => {
    try {
      const { token } = req.body;
  
      if (!token) {
        return res.status(400).json({ success: false, message: "Token is required" });
      }
  
      // Verify the token
      const decoded = jwt.verify(token, JWT_SECRET);
  
      // Fetch user details
      const user = await User.findById(decoded.userId).select("-password"); // Exclude password
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
  
      // Fetch ambulance details if the user is an ambulance driver
      let ambulanceDetails = null;
      if (user.userType === "ambulance") {
        const ambulance = await Ambulance.findOne({ userId: user._id });
        if (ambulance) {
          ambulanceDetails = {
            ambulanceId: ambulance._id,
            vehicleId: ambulance.vehicleId,
            vehicleType: ambulance.vehicleType,
            status: ambulance.status,
          };
        }
      }
  
      res.json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          number: user.number,
          userType: user.userType,
          status: user.status,
        },
        ambulanceDetails,
      });
    } catch (error) {
      console.error("Error verifying token:", error);
      res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
  });


// Profile Route
app.get("/profile", async (req, res) => {
    try {
      const token = req.headers.authorization?.split(" ")[1]; // Get token from Authorization header
      if (!token) {
        return res.status(401).json({ success: false, message: "Authorization token is required" });
      }
  
      // Verify the token
      const decoded = jwt.verify(token, JWT_SECRET);
  
      // Fetch user details
      const user = await User.findById(decoded.userId).select("-password"); // Exclude password
      if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
      }
  
      // Fetch ambulance details if the user is an ambulance driver
      let ambulanceDetails = null;
      if (user.userType === "ambulance") {
        const ambulance = await Ambulance.findOne({ userId: user._id });
        if (ambulance) {
          ambulanceDetails = {
            ambulanceId: ambulance._id,
            vehicleId: ambulance.vehicleId,
            vehicleType: ambulance.vehicleType,
            status: ambulance.status,
          };
        }
      }
  
      res.json({
        success: true,
        user: {
          id: user._id,
          name: user.name,
          email: user.email,
          number: user.number,
          userType: user.userType,
          status: user.status,
          lastLogin: user.lastLogin,
        },
        ambulanceDetails,
      });
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
  });



// Start the server
server.listen(PORT, () => console.log(`Ambulance tracking server running on http://localhost:${PORT}`));