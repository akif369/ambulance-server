const mongoose = require("mongoose");
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

module.exports = EmergencyRequest