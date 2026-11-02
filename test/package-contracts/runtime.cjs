// SPDX-License-Identifier: Apache-2.0
'use strict'
const openai = require('@ayayaq/vivi/providers/openai')
require('./contracts.cjs')(openai, 'installed CommonJS')
