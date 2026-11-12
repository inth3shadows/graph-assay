const app = require('express')()
function getUser (req, res) { res.json({}) }
app.get('/users/:id', getUser)
