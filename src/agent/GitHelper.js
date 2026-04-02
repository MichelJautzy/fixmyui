import { simpleGit } from 'simple-git';

/**
 * Git helper for the FixMyUI agent.
 * All operations run inside `repoPath`.
 */
export class GitHelper {
  #git;
  #repoPath;

  /**
   * @param {string} repoPath  Absolute path to the git repository root
   */
  constructor(repoPath) {
    this.#repoPath = repoPath;
    this.#git = simpleGit({ baseDir: repoPath, binary: 'git', maxConcurrentProcesses: 1 });
  }

  /**
   * Create a new branch and check it out.
   * @param {string} branchName
   * @returns {Promise<void>}
   */
  async checkoutBranch(branchName) {
    await this.#git.checkoutLocalBranch(branchName);
  }

  /**
   * Stage all changes (new files, modifications, deletions).
   * @returns {Promise<void>}
   */
  async addAll() {
    await this.#git.add('.');
  }

  /**
   * Commit staged changes.
   * @param {string} message
   * @returns {Promise<string>} short commit hash
   */
  async commit(message) {
    const result = await this.#git.commit(message);
    return result.commit;
  }

  /**
   * Push a branch to origin.
   * @param {string} branchName
   * @returns {Promise<void>}
   */
  async push(branchName) {
    await this.#git.push('origin', branchName, ['--set-upstream']);
  }

  /**
   * Return true if the working tree has any uncommitted changes.
   * @returns {Promise<boolean>}
   */
  async isDirty() {
    const status = await this.#git.status();
    return !status.isClean();
  }

  /**
   * Return the name of the current branch.
   * @returns {Promise<string>}
   */
  async currentBranch() {
    const status = await this.#git.status();
    return status.current;
  }

  /**
   * Checkout a branch if it exists, otherwise create it.
   * @param {string} branchName
   * @returns {Promise<void>}
   */
  async checkoutOrCreate(branchName) {
    try {
      await this.#git.checkout(branchName);
    } catch {
      await this.#git.checkoutLocalBranch(branchName);
    }
  }

  /**
   * Checkout an existing branch.
   * @param {string} targetBranch
   */
  async checkoutExisting(targetBranch) {
    await this.#git.checkout(targetBranch);
  }

  /**
   * Verify that repoPath is a git repository.
   * @throws if not a git repo
   */
  async assertIsRepo() {
    const isRepo = await this.#git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`${this.#repoPath} is not a git repository.`);
    }
  }
}
