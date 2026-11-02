// SPDX-License-Identifier: Apache-2.0
// Copy this directory beside the clean consumer's node_modules before execution.
import * as openai from '@ayayaq/vivi/providers/openai'
import register from './contracts.cjs'

register(openai, 'installed ESM')
