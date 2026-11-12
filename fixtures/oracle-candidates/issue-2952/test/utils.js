var utils = require('../lib/utils');
function t() { utils.etag('x'); utils.compileTrust(1); utils.missing(); }
module.exports = t;
