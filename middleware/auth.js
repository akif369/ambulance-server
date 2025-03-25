require("dotenv").config();

const JWT_SECRET = process.env.JWT_SECRET;


const authenticate = (req, res, next) => {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) return res.status(401).json({ message: "Unauthorized" });
  
    try {
      const decoded = jwt.verify(token,JWT_SECRET); // Replace with your actual secret key
      req.user = decoded;
      next();
    } catch (error) {
      return res.status(403).json({ message: "Invalid token" });
    }
  };
module.exports = authenticate