module.exports = {
  inspect () { return this.toJSON() },   // → Application.toJSON in lib/application.js
  toJSON () { return {} }
}
