#!/usr/bin/env bun
import { runForegroundServiceDaemon } from "../src/operations/service/native-service-daemon.ts";

await runForegroundServiceDaemon();
