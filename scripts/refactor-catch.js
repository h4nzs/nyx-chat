const fs = require('fs');
const path = require('path');

function processDir(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      let originalContent = content;

      const vars = ['e', 'error', 'err'];
      for (const v of vars) {
        // Regex to find 'catch (v: any) {' or 'catch (v: any)'
        // We'll search for the index of 'catch (v: any)'
        const catchStr = `catch (${v}: any)`;
        let searchIdx = 0;
        while (true) {
          const catchIdx = content.indexOf(catchStr, searchIdx);
          if (catchIdx === -1) break;

          // Replace 'catch (v: any)' with 'catch (v: unknown)'
          content = content.substring(0, catchIdx) + `catch (${v}: unknown)` + content.substring(catchIdx + catchStr.length);
          
          // Now we find the block following the catch
          // The block might start with '{' or it might be a single statement (though TS format usually has '{')
          const blockStartIdx = content.indexOf('{', catchIdx);
          if (blockStartIdx !== -1) {
            let braceCount = 1;
            let currentIdx = blockStartIdx + 1;
            while (currentIdx < content.length && braceCount > 0) {
              if (content[currentIdx] === '{') braceCount++;
              if (content[currentIdx] === '}') braceCount--;
              currentIdx++;
            }
            
            if (braceCount === 0) {
              const blockEndIdx = currentIdx;
              const blockBody = content.substring(blockStartIdx, blockEndIdx);
              
              // Replace v.message in the block body
              // Use regex to avoid replacing v.messages or other subsets
              const messagePattern = new RegExp(`\\b${v}\\.message\\b`, 'g');
              const newBlockBody = blockBody.replace(messagePattern, (match, offset, str) => {
                 // Check if it's already wrapped
                 const chunkBefore = str.substring(Math.max(0, offset - 150), offset);
                 if (chunkBefore.includes(`${v} instanceof Error`)) {
                   return match;
                 }
                 return `(${v} instanceof Error ? ${v}.message : 'Unknown error')`;
              });
              
              content = content.substring(0, blockStartIdx) + newBlockBody + content.substring(blockEndIdx);
              searchIdx = blockStartIdx + newBlockBody.length;
            } else {
              searchIdx = catchIdx + `catch (${v}: unknown)`.length;
            }
          } else {
             searchIdx = catchIdx + `catch (${v}: unknown)`.length;
          }
        }
      }
      if (content !== originalContent) {
        fs.writeFileSync(fullPath, content);
        console.log(`Updated ${fullPath}`);
      }
    }
  }
}

processDir(path.resolve('web/src'));
