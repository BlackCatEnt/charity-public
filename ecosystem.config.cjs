module.exports = {
  apps: [{
    name: "charity",
    cwd: "A:/Charity",
    script: "data/index.js",
    interpreter: "node",
    watch: false,
    time: true,
    env: { NODE_ENV: "production" }
  }]
}
