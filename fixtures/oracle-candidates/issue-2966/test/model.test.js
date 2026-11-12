const Model = require('../lib/model')
async function t () { await Model.init(); await Model.insertMany([1]) }
