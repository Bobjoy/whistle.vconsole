const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const vendorConfig = require('./vendor.json');

// ../protocol holds the single protocol source that webpack inlines into this
// bundle. tsc sees it as an external package and leaves the bare specifier in the
// emitted typings, so the declarations are spliced back in as an ambient module —
// otherwise @bobjoy/vconsole's types would name a package that is never published.
const PROTOCOL_MODULE = '@bobjoy/vconsole-protocol';

const protocolDeclarations = () => {
  const source = path.resolve(__dirname, '../../protocol/src/protocol.ts');
  const tmpDir = path.resolve(__dirname, '../dist/.protocol');
  execSync(`tsc ${JSON.stringify(source)} --target es2018 --declaration --emitDeclarationOnly --outDir ${JSON.stringify(tmpDir)}`);
  const dts = fs.readFileSync(path.join(tmpDir, 'protocol.d.ts'), 'utf8');
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // `export declare const` is invalid once nested inside a declare module block
  return `declare module "${PROTOCOL_MODULE}" {\n${dts.replace(/^export declare /gm, 'export ').trimEnd()}\n}\n\n`;
};

const main = () => {
  console.group('\nEmitting type declarations...');
  const distFile = './dist/vconsole.min.d.ts';
  if (fs.existsSync(distFile)) {
    fs.unlinkSync(distFile);
  }
  execSync('tsc --build ./tsconfig.type.json');
  let distContent = fs.readFileSync(distFile, 'utf8');
  for (const name of vendorConfig.name) {
    distContent = distContent.replace(new RegExp(`['"]${name}['"]`, 'g'), `"vendor/${name}"`);
  }
  const vendorContent = '/// <reference path="../build/vendor.d.ts" />\n\n';
  fs.writeFileSync(distFile, vendorContent + protocolDeclarations() + distContent, 'utf8');
  console.groupEnd();
};

main();