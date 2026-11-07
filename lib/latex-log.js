'use strict'
// A LaTeX run failed when its .log has a "! ..." error or a -file-line-error "file:line: ..." line.
const LOG_ERROR = /^(?:! |.+:\d+: )/m

module.exports = { LOG_ERROR }
