import { UsageError } from '../../errors.js';
import { createProject, PROJECT_GENRES } from '../../http/projects.js';
import type { ProjectPayload } from '../../output/contract.js';
import { writeJsonPayload, type OutputSink } from '../../output/envelope.js';
import { resolveProjectContext } from '../../project/context.js';

export interface ProjectCreateCommandOptions {
  name: string;
  genre: string;
  description?: string | undefined;
  json: boolean;
  apiUrl?: string | undefined;
}

export async function runProjectCreate(
  options: ProjectCreateCommandOptions,
  sink: OutputSink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!options.name.trim() || options.name.length > 80) {
    throw new UsageError(
      '--name must contain a non-whitespace character and be at most 80 characters.',
    );
  }
  const genre = PROJECT_GENRES.find((value) => value === options.genre.toUpperCase());
  if (genre === undefined) {
    throw new UsageError(`--genre must be one of ${PROJECT_GENRES.join(', ')}.`);
  }
  if (options.description !== undefined && options.description.length > 2000) {
    throw new UsageError('--description must be at most 2000 characters.');
  }

  const context = await resolveProjectContext(env, options.apiUrl);
  const project: ProjectPayload = await createProject(context.apiBaseUrl, context.cliToken, {
    name: options.name,
    genre,
    description: options.description,
  });
  if (options.json) {
    writeJsonPayload(sink, project);
    return;
  }
  sink.out(`Created project ${project.name} (ID: ${project.id}).`);
}
