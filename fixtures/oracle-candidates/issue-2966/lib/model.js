function Model () {}
Model.insertMany = async function insertMany (arr) { return arr }
Model.init = function init () { return Model.insertMany([]) }   // → Cast.insertMany in lib/other.js
module.exports = Model
