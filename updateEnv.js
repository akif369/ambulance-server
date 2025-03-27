const fs = require('fs');
const os = require('os');
const path = require('path');

// Function to get local IP
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const iface of Object.values(interfaces)) {
        for (const config of iface) {
            if (config.family === 'IPv4' && !config.internal) {
                return config.address;
            }
        }
    }
    return '127.0.0.1'; // Default to localhost
}

// Get the new IP
const newIP = getLocalIP();
const envPath = path.join(__dirname, '../ambuler/.env'); // Adjust if needed

// Read existing .env file
let envContent = '';
if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
}

// Replace or add new IP values
envContent = envContent
    .replace(/SERVER_API_URL=.*/g, `SERVER_API_URL=http://${newIP}:3000`)
    .replace(/SOCKET_API_URL=.*/g, `SOCKET_API_URL=http://${newIP}:3000`);

// Write back to .env file
fs.writeFileSync(envPath, envContent, 'utf8');

console.log(`✅ Updated .env in FRONTEND with IP: ${newIP}`);
