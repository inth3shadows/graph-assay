function createETagGenerator(options) { return function generateETag(body) { return body; }; }
exports.etag = createETagGenerator({ weak: false });
exports.normalizeType = function (type) { return type; };
exports.compileTrust = function compileTrust(val) { return val; };
