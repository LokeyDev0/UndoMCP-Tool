/**
 * Computes the diff between two arrays of lines using the standard LCS algorithm.
 * Optimized with a safety limit for file size.
 */
export function diffLines(oldLines, newLines) {
    const n = oldLines.length;
    const m = newLines.length;
    if (n * m > 4000000) {
        // Large files: fallback to simple block comparison to avoid memory limits
        return fallbackDiff(oldLines, newLines);
    }
    const dp = [];
    for (let i = 0; i <= n; i++) {
        dp.push(new Int32Array(m + 1));
    }
    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            if (oldLines[i - 1] === newLines[j - 1]) {
                dp[i][j] = dp[i - 1][j - 1] + 1;
            }
            else {
                dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
            }
        }
    }
    const result = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
            result.unshift({ type: 'unchanged', content: oldLines[i - 1] });
            i--;
            j--;
        }
        else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            result.unshift({ type: 'added', content: newLines[j - 1] });
            j--;
        }
        else {
            result.unshift({ type: 'removed', content: oldLines[i - 1] });
            i--;
        }
    }
    return result;
}
function fallbackDiff(oldLines, newLines) {
    const result = [];
    for (const line of oldLines) {
        result.push({ type: 'removed', content: line });
    }
    for (const line of newLines) {
        result.push({ type: 'added', content: line });
    }
    return result;
}
/**
 * Generates a clean unified diff string between old and new file content.
 */
export function generateUnifiedDiff(filePath, oldContent, newContent) {
    const oldStr = oldContent ?? '';
    const newStr = newContent ?? '';
    if (oldStr === newStr) {
        return '';
    }
    const oldLines = oldContent === null || oldContent === undefined ? [] : oldContent.split(/\r?\n/);
    const newLines = newContent === null || newContent === undefined ? [] : newContent.split(/\r?\n/);
    const diffs = diffLines(oldLines, newLines);
    let oldLineNum = 1;
    let newLineNum = 1;
    const linesWithIndex = diffs.map((d) => {
        const item = {
            type: d.type,
            content: d.content,
            oldLineNum: d.type !== 'added' ? oldLineNum : null,
            newLineNum: d.type !== 'removed' ? newLineNum : null,
        };
        if (d.type !== 'added')
            oldLineNum++;
        if (d.type !== 'removed')
            newLineNum++;
        return item;
    });
    const changedIndices = linesWithIndex
        .map((line, idx) => (line.type !== 'unchanged' ? idx : -1))
        .filter((idx) => idx !== -1);
    if (changedIndices.length === 0) {
        return '';
    }
    const CONTEXT_SIZE = 3;
    const hunks = [];
    for (const idx of changedIndices) {
        const start = Math.max(0, idx - CONTEXT_SIZE);
        const end = Math.min(linesWithIndex.length - 1, idx + CONTEXT_SIZE);
        if (hunks.length === 0) {
            hunks.push({ start, end });
        }
        else {
            const last = hunks[hunks.length - 1];
            if (start <= last.end + 1) {
                last.end = Math.max(last.end, end);
            }
            else {
                hunks.push({ start, end });
            }
        }
    }
    let diffText = '';
    const oldPath = oldContent === null || oldContent === undefined ? '/dev/null' : `a/${filePath}`;
    const newPath = newContent === null || newContent === undefined ? '/dev/null' : `b/${filePath}`;
    diffText += `--- ${oldPath}\n`;
    diffText += `+++ ${newPath}\n`;
    for (const hunk of hunks) {
        const hunkLines = linesWithIndex.slice(hunk.start, hunk.end + 1);
        let oldStart = 0;
        let oldLength = 0;
        for (const hl of hunkLines) {
            if (hl.oldLineNum !== null) {
                if (oldStart === 0)
                    oldStart = hl.oldLineNum;
                oldLength++;
            }
        }
        let newStart = 0;
        let newLength = 0;
        for (const hl of hunkLines) {
            if (hl.newLineNum !== null) {
                if (newStart === 0)
                    newStart = hl.newLineNum;
                newLength++;
            }
        }
        let oldRange = '';
        if (oldLength === 0) {
            oldRange = '0,0';
        }
        else if (oldLength === 1) {
            oldRange = `${oldStart}`;
        }
        else {
            oldRange = `${oldStart},${oldLength}`;
        }
        let newRange = '';
        if (newLength === 0) {
            newRange = '0,0';
        }
        else if (newLength === 1) {
            newRange = `${newStart}`;
        }
        else {
            newRange = `${newStart},${newLength}`;
        }
        diffText += `@@ -${oldRange} +${newRange} @@\n`;
        for (const hl of hunkLines) {
            if (hl.type === 'unchanged') {
                diffText += ` ${hl.content}\n`;
            }
            else if (hl.type === 'added') {
                diffText += `+${hl.content}\n`;
            }
            else {
                diffText += `-${hl.content}\n`;
            }
        }
    }
    return diffText;
}
