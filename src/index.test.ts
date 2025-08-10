import { describe, it, expect, vi } from 'vitest';
import worker from './index';
import { CodeSuggestion } from './types';

describe('Worker Logic', () => {
  describe('parseSuggestionsFromComment', () => {
    it('should parse a single diff block correctly from a comment', () => {
      const commentBody = `
        Here is a suggestion to improve performance.
        \`\`\`diff
        --- a/src/utils/performance.js
        +++ b/src/utils/performance.js
        @@ -10,1 +10,1 @@
        - const result = expensiveCalculation();
        + const result = memoizedCalculation();
        \`\`\`
        Let me know what you think.
      `;

      const suggestions: CodeSuggestion[] = worker.parseSuggestionsFromComment(commentBody);

      expect(suggestions).toHaveLength(1);
      expect(suggestions[0]).toEqual({
        filePath: 'src/utils/performance.js',
        diff: '@@ -10,1 +10,1 @@\n- const result = expensiveCalculation();\n+ const result = memoizedCalculation();',
      });
    });

    it('should return an empty array if no diff block is present', () => {
      const commentBody = 'This is a regular comment without any code suggestions.';
      const suggestions = worker.parseSuggestionsFromComment(commentBody);
      expect(suggestions).toHaveLength(0);
    });

    it('should correctly parse multiple diff blocks from a single comment', () => {
      const commentBody = `
        I have a couple of suggestions.

        First, for the main file:
        \`\`\`diff
        --- a/src/index.ts
        +++ b/src/index.ts
        - old line
        + new line
        \`\`\`

        Second, a tweak to the config:
        \`\`\`diff
        --- a/wrangler.toml
        +++ b/wrangler.toml
        - key = "old"
        + key = "new"
        \`\`\`
      `;
      const suggestions = worker.parseSuggestionsFromComment(commentBody);
      expect(suggestions).toHaveLength(2);
      expect(suggestions[0].filePath).toBe('src/index.ts');
      expect(suggestions[1].filePath).toBe('wrangler.toml');
      expect(suggestions[1].diff).toBe('- key = "old"\n+ key = "new"');
    });

    it('should ignore non-diff code blocks', () => {
      const commentBody = `
        Here is a normal code block:
        \`\`\`javascript
        console.log('hello');
        \`\`\`
        And here is the suggestion:
        \`\`\`diff
        --- a/src/index.js
        +++ b/src/index.js
        - console.log('old');
        + console.log('new');
        \`\`\`
      `;
      const suggestions = worker.parseSuggestionsFromComment(commentBody);
      expect(suggestions).toHaveLength(1);
      expect(suggestions[0].filePath).toBe('src/index.js');
    });

    it('should return an empty array for a diff block with no content', () => {
        const commentBody = '```diff\n--- a/src/index.js\n+++ b/src/index.js\n```';
        const suggestions = worker.parseSuggestionsFromComment(commentBody);
        expect(suggestions).toHaveLength(0);
    });
  });
});
