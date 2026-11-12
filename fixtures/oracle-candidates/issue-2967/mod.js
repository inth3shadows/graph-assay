function setup () {
  function build () { return 1 }
  return build()
}
function build () { return 2 }
module.exports = build
