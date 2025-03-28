// Load environment variables
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const http = require("http");
const socketIo = require("socket.io");
const cors = require("cors");
const { instrument } = require("@socket.io/admin-ui");

const authenticate = require("./middleware/auth");

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: ["*", "https://admin.socket.io"] },
});
instrument(io, {
  auth: false,
  mode: "development",
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// Models

const User = require("./models/User");
const Ambulance = require("./models/Ambulance");
const EmergencyRequest = require("./models/Emergency");

// Middleware
app.use(express.json());
app.use(cors());

// Connect to MongoDB
mongoose
  .connect(process.env.MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// Store ambulance locations and socket mappings
const onlineAmbulances = {};
const userSocketMap = {};

const driverIo = io.of("/driver");
const clientIo = io.of("/client");

const activeDrivers = new Map(); // Store active drivers (socket.id -> vehicleId)
const pendingRequests = new Map();

driverIo.on("connection", (socket) => {
  console.log(`\x1b[32m${socket.id} User connected\x1b[0m`);

  socket.on("update-status", async ({ vehicleId, status }) => {
    console.log(`🚑 Driver status of ${socket.id} updated to ${status}`);

    try {
      let updateFields = {
        status,
        "currentLocation.lastUpdated": new Date(),
      };

      // Disable discount and remove ambulance when offline
      if (status === "offline" || status === "at_hospital") {
        updateFields.discount = false;
      }

      const updatedAmbulance = await Ambulance.findOneAndUpdate(
        { vehicleId },
        updateFields,
        { new: true }
      );

      if (updatedAmbulance) {
        console.log(`✅ Ambulance ${vehicleId} status updated to ${status}`);

        if (status == false) clientIo.emit("remove-ambulance", { vehicleId });
        if (status === "offline" || status === "at_hospital") {
          console.log(
            `🛑 Removing ambulance ${vehicleId} from activeDrivers and notifying clients`
          );
          activeDrivers.delete(socket.id);
        } else {
          activeDrivers.set(socket.id, {
            vehicleId,
            latitude: null,
            longitude: null,
          }); // Keep tracking active
        }
      } else {
        console.log(`🚨 No ambulance found with vehicleId: ${vehicleId}`);
      }
    } catch (error) {
      console.error("❌ Error updating ambulance status:", error);
    }
  });

  socket.on("location-update", async ({ vehicleId, latitude, longitude }) => {
    console.log(
      `📍 Location update for ${vehicleId}: (${latitude}, ${longitude})`
    );

    try {
      await Ambulance.findOneAndUpdate(
        { vehicleId },
        {
          "currentLocation.latitude": latitude,
          "currentLocation.longitude": longitude,
          "currentLocation.lastUpdated": new Date(),
        }
      );
      console.log(`✅ Location updated for ${vehicleId}`);

      // Broadcast location update to all connected clients
      clientIo.emit("ambulance-location", { vehicleId, latitude, longitude });
    } catch (error) {
      console.error("❌ Error updating location:", error);
    }
  });

  socket.on("get-pending-requests", async () => {
    try {
      // Get all pending requests from database
      const pendingRequestsdb = await EmergencyRequest.find({
        status: "pending",
      })
        .populate("requesterId", "name phone")
        .lean();

      // Convert to GeoJSON format for easier mapping
      const formattedRequests = pendingRequestsdb.map((request) => ({
        _id: request._id.toString(),
        location: request.location,
        emergencyDetails: request.emergencyDetails,
        patientCount: request.patientCount,
        criticalLevel: request.criticalLevel,
        createdAt: request.createdAt,
        requester: request.requesterId,
      }));

      // Add to pendingRequests map
      formattedRequests.forEach((request) => {
        pendingRequests.set(request._id, {
          ...request,
          socketId: socket.id, // Store driver's socket ID
        });
      });

      // Send to requesting driver
      socket.emit("pending-requests", formattedRequests);
      console.log(
        `📋 Sent ${formattedRequests.length} pending requests to driver ${socket.id}`
      );
    } catch (error) {
      console.error("Error fetching pending requests:", error);
      socket.emit("request-error", "Failed to fetch pending requests");
    }
  });

  socket.on("accept-request", async ({ requestId, vehicleId }) => {
    console.log(requestId, vehicleId,"this is wee")
    try {
      const pendingRequestsdb = await EmergencyRequest.find({
        status: "pending",
      })
        .populate("requesterId")

        

      // Convert to GeoJSON format for easier mapping
      const formattedRequests = pendingRequestsdb.map((request) => ({
        _id: request._id.toString(),
        location: request.location,
        emergencyDetails: request.emergencyDetails,
        patientCount: request.patientCount,
        criticalLevel: request.criticalLevel,
        createdAt: request.createdAt,
        requester: request.requesterId,
      }));

      // Add to pendingRequests map
      formattedRequests.forEach((request) => {
        pendingRequests.set(request._id, {
          ...request,
          socketId: socket.id, // Store driver's socket ID
        });
      });

      const requestIdString = requestId;
      const request = pendingRequests.get(requestId);
      console.log("test",request,request)
      if (!request) {
        throw new Error("Request no longer available");
      }

      // Create private room with original client
      const roomId = `emergency-${requestIdString}`;
      socket.join(roomId); // Driver joins
      clientIo.to(request.socketId).socketsJoin(roomId); // Client joins
      socket.emit("accepted-progress");


      // Update database
      await EmergencyRequest.findByIdAndUpdate(requestId, {
        status: "accepted",
        ambulanceId: vehicleId,
      });

      // Cleanup
      pendingRequests.delete(requestIdString);
      driverIo.emit("request-removed", requestIdString);
    } catch (error) {
      console.error("Accept error:", error);
      socket.emit("accept-error", error.message);
    }
  });
  socket.on("update-request-status",async ( {
    requestId,
    status
  })=>{
    try{

    await EmergencyRequest.findByIdAndUpdate(requestId, {
      status: status
    });
    socket.emit("accepted-progress-disable");
  } catch (error) {
    console.error("update request status:", error);
  

  }
    

  })

  // Handle socket disconnection
  socket.on("disconnect", async () => {
    console.log(`\x1b[31m${socket.id} User Disconnected\x1b[0m`);

    const driverData = activeDrivers.get(socket.id);
    if (!driverData) {
      console.log(`🚨 No vehicle found for disconnected socket: ${socket.id}`);
      return;
    }

    const { vehicleId } = driverData;
    try {
      const updatedAmbulance = await Ambulance.findOneAndUpdate(
        { vehicleId },
        {
          status: "offline",
          discount: false,
          "currentLocation.lastUpdated": new Date(),
        },
        { new: true }
      );

      if (updatedAmbulance) {
        console.log(
          `🚑 Ambulance ${vehicleId} set to offline due to disconnection.`
        );

        // Notify all clients to remove the ambulance from the map
        clientIo.emit("remove-ambulance", { vehicleId });
      }

      activeDrivers.delete(socket.id); // Remove from active drivers map
    } catch (error) {
      console.error("Error setting ambulance offline:", error);
    }
  });
});

clientIo.on("connection", (socket) => {
  console.log(`\x1b[32m${socket.id} User connected\x1b[0m`);

  socket.on("setAmbulance", async () => {
    console.log(`🚑 Client requested all active ambulances`);

    try {
      // Fetch all active ambulances from the database
      const activeAmbulances = await Ambulance.find({
        status: { $ne: "offline" },
      });

      // Emit active ambulances to the client
      socket.emit("active-ambulances", activeAmbulances);
      console.log("📍 Sent all active ambulances to client");
    } catch (error) {
      console.error("Error sending active ambulances:", error);
    }
  });

  socket.on("EmergencyRequest", ({ userId, latitude, longitude }) => {
    console.log("emergency called");
  });

  socket.on("emergency-request", async (requestData) => {
    try {
      // Validate request data

      if (!requestData.userId || !requestData.location) {
        throw new Error("Invalid request data");
      }

      // Create new emergency request
      const newRequest = new EmergencyRequest({
        requesterId: requestData.userId,
        location: requestData.location,
        emergencyDetails: requestData.emergencyDetails,
        patientCount: requestData.patientCount,
        criticalLevel: requestData.criticalLevel,
        status: "pending",
        _id: requestData.userId._id,
      });

      await newRequest.save();

      // Store in memory for faster access
      pendingRequests.set(newRequest._id.toString(), {
        ...newRequest.toObject(),
        socketId: socket.id,
      });

      // Broadcast to all drivers
      driverIo.emit("new-emergency-request", {
        requestId: newRequest._id,
        location: newRequest.location,
        emergencyDetails: newRequest.emergencyDetails,
        patientCount: newRequest.patientCount,
        criticalLevel: newRequest.criticalLevel,
        createdAt: newRequest.createdAt,
      });

      console.log(`🚨 New emergency request from ${requestData.userId}`);
    } catch (error) {
      console.error("Error handling emergency request:", error);
      socket.emit("request-error", "Failed to process emergency request");
    }
  });

  // Handle socket disconnection
  socket.on("disconnect", async () => {
    console.log(`\x1b[31m${socket.id} User Disconnected\x1b[0m`);
  });
});

// Register Route
app.post("/register", async (req, res) => {
  try {
    const { name, email, number, password, userType, vehicleId, vehicleType } =
      req.body;
    if (!name || !email || !number || !password) {
      return res.status(400).json({ message: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser)
      return res.status(400).json({ message: "User already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({
      name,
      email,
      number,
      password: hashedPassword,
      userType: userType || "client",
    });
    await newUser.save();

    // If registering as an ambulance, create ambulance record
    const generateVehicleId = () => {
      return "AMB-" + Math.random().toString(36).substring(2, 8).toUpperCase();
    };
    if (userType === "ambulance") {
      const newAmbulance = new Ambulance({
        userId: newUser._id,
        vehicleId: generateVehicleId(),
        vehicleType: vehicleType || "basic",
        status: "offline",
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
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });

    user.lastLogin = new Date();
    await user.save();

    const token = jwt.sign(
      { userId: user._id, userType: user.userType },
      JWT_SECRET,
      { expiresIn: "7d" }
    );

    // If user is an ambulance, include ambulance details
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

    res.json({ token, userType: user.userType, ambulanceDetails });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/getAmbulance", authenticate, async (req, res) => {
  try {
    const userID = req.user.userId; // Extract userId from the decoded token

    // Convert userID string to ObjectId
    const objectId = new mongoose.Types.ObjectId(userID);

    const ambulance = await Ambulance.findOne({ userId: objectId });

    if (!ambulance) {
      return res.status(404).json({ message: "Ambulance details not found." });
    }

    console.log("Ambulance Details:", ambulance);
    res.json(ambulance);
  } catch (error) {
    console.error("Error fetching ambulance details:", error);
    res.status(500).json({ message: "Internal server error." });
  }
});

// Get nearby ambulances
app.get("/nearby-ambulances", async (req, res) => {
  try {
    const { latitude, longitude, radius = 10 } = req.query; // radius in kilometers

    if (!latitude || !longitude) {
      return res
        .status(400)
        .json({ message: "Latitude and longitude are required" });
    }

    // Find ambulances that are online or on duty
    const ambulances = await Ambulance.find({
      status: { $in: ["available", "on_route", "with_patient", "at_hospital"] },
      "currentLocation.latitude": { $ne: null },
      "currentLocation.longitude": { $ne: null },
    }).populate("userId", "name");

    // In a real app, you'd implement proper distance calculation with MongoDB geospatial queries
    // This is a simplified version for demonstration purposes
    const nearbyAmbulances = ambulances.map((ambulance) => ({
      id: ambulance._id,
      driverName: ambulance.userId.name,
      vehicleType: ambulance.vehicleType,
      status: ambulance.status,
      location: ambulance.currentLocation,
      // In a real app you would calculate actual distance here
      distance: "calculating...", // Placeholder
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

    const request = await EmergencyRequest.findById(requestId).populate({
      path: "ambulanceId",
      select: "vehicleId vehicleType currentLocation status",
      populate: {
        path: "userId",
        select: "name number",
      },
    });

    if (!request) {
      return res.status(404).json({ message: "Emergency request not found" });
    }

    // Verify the requester is authorized to see this request
    if (
      request.requesterId.toString() !== decoded.userId &&
      decoded.userType !== "admin"
    ) {
      return res
        .status(403)
        .json({ message: "Not authorized to view this request" });
    }

    res.json({
      request: {
        id: request._id,
        status: request.status,
        location: request.location,
        emergencyDetails: request.emergencyDetails,
        createdAt: request.createdAt,
        completedAt: request.completedAt,
        ambulance: request.ambulanceId
          ? {
              id: request.ambulanceId._id,
              vehicleId: request.ambulanceId.vehicleId,
              vehicleType: request.ambulanceId.vehicleType,
              currentLocation: request.ambulanceId.currentLocation,
              status: request.ambulanceId.status,
              driverName: request.ambulanceId.userId?.name,
              driverContact: request.ambulanceId.userId?.number,
            }
          : null,
      },
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
      return res
        .status(400)
        .json({ success: false, message: "Token is required" });
    }

    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Fetch user details
    const user = await User.findById(decoded.userId).select("-password"); // Exclude password
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
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
    res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

// Profile Route
app.get("/profile", async (req, res) => {
  try {
    const token = req.headers.authorization?.split(" ")[1]; // Get token from Authorization header
    if (!token) {
      return res
        .status(401)
        .json({ success: false, message: "Authorization token is required" });
    }

    // Verify the token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Fetch user details
    const user = await User.findById(decoded.userId).select("-password"); // Exclude password
    if (!user) {
      return res
        .status(404)
        .json({ success: false, message: "User not found" });
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
    res
      .status(401)
      .json({ success: false, message: "Invalid or expired token" });
  }
});

app.post("/update-status", async (req, res) => {
  console.log("update status");
  try {
    const { status } = req.body;
    const driverId = req.user.id; // Extracted from token

    // Find and update driver status in MongoDB
    const driver = await Driver.findByIdAndUpdate(
      driverId,
      { status },
      { new: true }
    );

    if (!driver) return res.status(404).json({ message: "Driver not found" });

    // Emit status update via Socket.IO (if applicable)
    io.emit("driverStatusUpdate", { driverId, status });

    res.json({ message: "Status updated successfully", driver });
  } catch (error) {
    console.error("Error updating driver status:", error);
    res.status(500).json({ message: "Internal Server Error" });
  }
});

// Start the server
server.listen(PORT, () =>
  console.log(`Ambulance tracking server running on http://localhost:${PORT}`)
);
