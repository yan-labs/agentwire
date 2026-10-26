import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
// A release candidate must include the real site build.
for(const [source,target] of [['wrangler.jsonc','.wrangler-build.json'],['wrangler.site.jsonc','.wrangler-site-build.json']]) {
 const config=JSON.parse(readFileSync(source,'utf8'));
 if(!existsSync('site/dist/index.html')) throw Error('Build site first: pnpm --dir site build');
 writeFileSync(target,JSON.stringify(config,null,2));
}
const result=spawnSync('pnpm',['exec','esbuild','src/index.ts','--bundle','--format=esm','--outfile=dist/worker.js','--conditions=workerd,worker,browser','--main-fields=browser,module,main','--external:cloudflare:workers'],{stdio:'inherit'});
process.exitCode=result.status??1;
