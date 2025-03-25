const mongoose = require("mongoose");

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

module.exports = User