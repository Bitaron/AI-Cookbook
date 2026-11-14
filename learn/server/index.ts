#!/usr/bin/env bun
// Server entry point: `bun server/index.ts` (the `learn` CLI starts this in the background).
import { startServer } from "./server";
import { baseUrl } from "./config";

const fake = process.env.LEARN_FAKE_AGENT === "1";
const queryFn = fake ? (await import("./fake-agent")).fakeQuery : undefined;
const { port } = startServer({ queryFn });
console.log(`learn server on ${baseUrl().replace(/:\d+$/, `:${port}`)}${fake ? " (fake agent)" : ""}`);
