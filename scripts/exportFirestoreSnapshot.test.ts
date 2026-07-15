import { it } from "vitest";
import { exportTrainingWebSnapshot } from "./exportFirestoreSnapshot";
import * as path from "node:path";

const MODE = process.env.SNAPSHOT_EXPORT; // undefined | "1"
const UID = 'eR9gJQK1eBflP9syhPRtPbiF6Kh2';

it.skipIf(!MODE)(
  "export training-web snapshot to local JSON",
  async () => {
    const outputPath = path.resolve(__dirname, 'snapshots', 'training-web-snapshot.json');
    await exportTrainingWebSnapshot(UID, outputPath);
  },
  600_000
);
