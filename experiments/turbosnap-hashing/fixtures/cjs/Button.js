'use strict';
const theme = require('./theme');
const { format } = require('./util');
module.exports = () => format(theme.color);
