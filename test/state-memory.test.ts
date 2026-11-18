import { createMemoryState } from "@chat-adapter/state-memory";
import { defineStateAdapterSuite } from "./helpers/state-adapter-suite.js";

defineStateAdapterSuite("state-memory", createMemoryState);
