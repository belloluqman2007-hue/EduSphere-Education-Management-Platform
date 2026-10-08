"use strict";
/* ============================================================================
   MULTI-MADRASA PLATFORM — which filesystem is a directory on?
   ----------------------------------------------------------------------------
   Whether anything written to a directory survives a redeploy depends on the
   filesystem that backs it. Two callers need that answer:
     • config.js picks the data directory on Render BEFORE the rest of the app
       loads, so this module must not depend on config (no require cycle);
     • services/persistence.js reports the storage verdict at boot and in the
       super-admin diagnostics.
   Linux only: everything here reads /proc/mounts and degrades to "unknown".
   ========================================================================== */
const fs = require("fs");
const path = require("path");

/* A real block device counts as durable even when it is mounted at / (a plain
   VPS). Anything else at / is the container and is thrown away on redeploy. */
const REAL_DEVICE = /^\/dev\/(sd[a-z]|nvme|vd[a-z]|xvd[a-z]|disk\/|mapper\/|md)/;
/* Filesystem types that are thrown away with the container. */
const EPHEMERAL_FS = new Set(["overlay", "tmpfs", "ramfs", "devtmpfs", "9p", "squashfs", "fuse-overlayfs"]);

/** Contents of the mount table, or null where there is none (non-Linux). */
function readMountTable(file = "/proc/mounts") {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    return null;
  }
}

/**
 * The longest mount point in the table that covers `target`, or null when the
 * table is unavailable. `root` is false for "/" (the container or VPS root) and
 * true for a dedicated mount such as a Render disk at /var/data.
 */
function findMountFor(target, mountsText = readMountTable()) {
  if (typeof mountsText !== "string") return null;
  let best = null;
  for (const line of mountsText.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const [device, mountPoint, fstype] = parts;
    if (!mountPoint) continue;
    const resolved = path.resolve(mountPoint);
    const covers = resolved === "/" || target === resolved || target.startsWith(resolved + path.sep);
    if (!covers) continue;
    if (!best || resolved.length > best.mountPoint.length) {
      best = { device, mountPoint: resolved, fstype, root: resolved !== "/" };
    }
  }
  return best;
}

/**
 * Durability verdict for the mount that backs a path:
 *   true  — survives a redeploy (a real disk, or a dedicated non-throwaway mount)
 *   false — the container's disposable filesystem, or a throwaway filesystem type
 *   null  — unknown (no mount table, so no opinion)
 */
function durabilityOf(mount) {
  if (!mount) return null;
  if (REAL_DEVICE.test(String(mount.device || ""))) return true;
  return !!mount.root && !EPHEMERAL_FS.has(mount.fstype);
}

/** True only for a DEDICATED durable mount at (or above) `dir` — never the container root. */
function hasDurableMountFor(dir, mountsText) {
  const mount = findMountFor(path.resolve(dir), mountsText);
  return !!mount && mount.root && durabilityOf(mount) === true;
}

/**
 * The data directory to use when DATA_DIR is not set in the environment.
 *
 * On Render the disk is mounted at PERSISTENT_VOLUME_DIR (render.yaml:
 * disk.mountPath). When that disk really is mounted it is the one place a
 * deploy does not erase, so it becomes the default: the database snapshots,
 * uploads and state marker then persist even when the service's environment
 * was never synced. Everywhere else the default stays ./data, as before.
 */
function pickDefaultDataDir({ isRender, persistentVolumeDir, mountsText } = {}) {
  if (isRender && persistentVolumeDir && hasDurableMountFor(persistentVolumeDir, mountsText)) {
    return persistentVolumeDir;
  }
  return "./data";
}

module.exports = {
  REAL_DEVICE,
  EPHEMERAL_FS,
  readMountTable,
  findMountFor,
  durabilityOf,
  hasDurableMountFor,
  pickDefaultDataDir,
};
