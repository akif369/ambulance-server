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