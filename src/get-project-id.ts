import { db } from './src/db';
import { projects } from './src/db/schema';

async function main() {
  const allProjects = await db.select({ id: projects.id, name: projects.name }).from(projects).limit(5);
  console.log('Available projects:', JSON.stringify(allProjects, null, 2));
  process.exit(0);
}

main().catch(console.error);
