var request = require("supertest");
var lib = require("./lib");

function run(app) {
  request(app);
  return lib.helper();
}

module.exports = { run };

var path = require("path");
var basename = path.basename;
var get = lib.helper;

function more(p) {
  basename(p);
  return get();
}

module.exports.more = more;
