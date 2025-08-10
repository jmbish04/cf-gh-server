/**
 * This file contains the type definitions for the configuration objects used in the worker.
 */

/**
 * Represents the configuration for the worker's behavior on a per-repository basis.
 * This configuration is stored in a JSON file in each repository (e.g., .github/worker-settings.json).
 */
export interface RepoConfig {
  /**
   * Whether to automatically process pull requests with Gemini Code Assist comments.
   * @default false
   */
  automatic_pr_processing: boolean;

  /**
   * The AI model to use for generating code.
   * e.g. "gemini-1.5-pro-latest"
   */
  ai_model?: string;

  /**
   * A map of custom prompts to be used by the AI model for specific tasks.
   * The key is the task name, and the value is the custom prompt.
   */
  custom_prompts?: Record<string, string>;

  /**
   * A list of file paths to ignore when processing pull requests.
   * The paths should be relative to the root of the repository and use forward slashes.
   */
  ignored_files?: string[];

  /**
   * The username of the bot that provides code suggestions.
   * Only comments from this user will be processed.
   * @default "gemini-code-assist[bot]"
   */
  bot_username?: string;

  /**
   * The name of the primary/main branch for the repository.
   * Used for integration after PR merges.
   * @default "main"
   */
  primary_branch?: string;
}

/**
 * Represents a single code suggestion parsed from a comment.
 */
export interface CodeSuggestion {
  /**
   * The path to the file that the suggestion applies to.
   */
  filePath: string;
  /**
   * The diff content of the suggestion.
   */
  diff: string;
}
