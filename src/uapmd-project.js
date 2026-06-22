import { readFileSync } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { repoRoot } from './paths.js';

export async function readUapmdProjectPluginReferences(projectFile) {
  const localPath = path.isAbsolute(projectFile) ? projectFile : path.join(repoRoot, projectFile);
  if (localPath.endsWith('.uapmdz')) return readUapmdzPluginReferences(localPath);
  return readPlainProjectPluginReferences(localPath);
}

function readUapmdzPluginReferences(projectFile) {
  const zip = new AdmZip(projectFile);
  const project = readJsonEntry(zip, 'project.uapmd');
  return readGraphPluginReferences(project, (graphFile) => readJsonEntry(zip, graphFile));
}

function readPlainProjectPluginReferences(projectFile) {
  const project = JSON.parse(readFileSync(projectFile, 'utf8'));
  const baseDir = path.dirname(projectFile);
  return readGraphPluginReferences(project, (graphFile) =>
    JSON.parse(readFileSync(path.join(baseDir, graphFile), 'utf8')));
}

function readGraphPluginReferences(project, readGraph) {
  const refs = [];
  const tracks = project.tracks ?? [];
  for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
    refs.push(...readTrackGraphPluginReferences(tracks[trackIndex], trackIndex, readGraph));
  }
  if (project.master_track)
    refs.push(...readTrackGraphPluginReferences(project.master_track, -1, readGraph));
  return refs;
}

function readTrackGraphPluginReferences(track, trackIndex, readGraph) {
  const graphFile = track?.graph?.external_file;
  if (!graphFile) return [];
  const graph = readGraph(graphFile);
  const plugins = graph.plugins ?? [];
  const refs = [];
  for (let pluginIndex = 0; pluginIndex < plugins.length; pluginIndex++) {
    const plugin = plugins[pluginIndex];
    if (!plugin.plugin_id) continue;
    refs.push({
      trackIndex,
      pluginIndex,
      pluginId: plugin.plugin_id,
      format: plugin.format ?? '',
      displayName: plugin.display_name ?? plugin.plugin_id,
      graphFile,
    });
  }
  return refs;
}

function readJsonEntry(zip, name) {
  const entry = zip.getEntry(name);
  if (!entry) throw new Error(`Project archive is missing "${name}".`);
  return JSON.parse(entry.getData().toString('utf8'));
}
