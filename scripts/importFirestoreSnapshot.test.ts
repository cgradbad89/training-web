import { it } from "vitest";
import { importTrainingWebSnapshot } from "./importFirestoreSnapshot";
import * as path from "node:path";

const MODE = process.env.SNAPSHOT_IMPORT; // undefined | "1"

it.skipIf(!MODE)(
  "import training-web snapshot to local emulator ONLY",
  async () => {
    const inputPath = path.resolve(__dirname, 'snapshots', 'training-web-snapshot.json');
    await importTrainingWebSnapshot(inputPath);
  },
  600_000
);
