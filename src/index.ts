#!/usr/bin/env node
// pulse — runtime radar. All logic lives in cli.ts; this is only the bin entry.
import { main } from './cli.js';

process.exitCode = await main(process.argv.slice(2));
