const mongoose = require("mongoose");

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

module.exports = Ambulance