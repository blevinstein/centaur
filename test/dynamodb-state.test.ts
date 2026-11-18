import { createAdapterOnFreshTable } from "./helpers/dynamodb-local.js";
import { defineStateAdapterSuite } from "./helpers/state-adapter-suite.js";

defineStateAdapterSuite("dynamodb-state (DynamoDB Local)", createAdapterOnFreshTable);
