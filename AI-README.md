# AI-README for braid-text

This document provides AI assistants with key information about the braid-text project, including development procedures and architecture notes.

## Release Procedure

Follow these steps to create a new release:

1. **Version Bump**
   - Update the version in `package.json` (use smallest version bump: patch level)
   - Current version format: `0.2.x`

2. **Run Tests**
   - Run `node test/test.js` - should show all 74 tests passing
   - Run `node test/fuzz-test.js` - should run without errors (best_n = Infinity @ NaN indicates success)
   - Both tests must pass before proceeding

3. **Commit Changes**
   - Use commit message format: `VERSION - description`
   - Example: `0.2.73 - adds automatic test cleanup`
   - Keep description concise and descriptive

4. **Push to Remote**
   - Run `git push` to push to the remote repository

5. **Publish to npm**
   - Run `npm publish` to publish the new version

## Test Suite

### test/test.js
- Main test suite with 74 tests
- Tests Braid protocol, version control, syncing, and collaboration features
- Automatically cleans up `test_db_folder` after completion
- Run with: `node test/test.js`
- Filter tests with: `node test/test.js --filter="sync"`

### test/fuzz-test.js
- Fuzz testing suite that generates random edits and verifies correctness
- Tests diamond-types integration and merge operations
- Runs 10,000 iterations by default
- Success indicated by `best_n = Infinity @ NaN` (no failures found)
- Run with: `node test/fuzz-test.js`

## Project Structure

- **index.js** - Main library file implementing Braid protocol for collaborative text
- **package.json** - Package configuration and dependencies
- **test/** - Test suite directory
  - **test.js** - Main test runner (supports both console and browser modes)
  - **tests.js** - Test definitions (shared between console and browser)
  - **fuzz-test.js** - Fuzz testing suite
  - **test.html** - Browser test interface

## Key Dependencies

- **@braid.org/diamond-types-node** - CRDT implementation for conflict-free text editing
- **braid-http** - Braid protocol HTTP implementation
- **url-file-db** - File-based database for persistent storage

## Architecture Notes

- Implements the Braid protocol for synchronizing collaborative text over HTTP
- Uses diamond-types CRDT for conflict-free merging
- Supports both simpleton and dt (diamond-types) merge strategies
- Provides version control with parents tracking and version history
- File-based persistence with case-insensitive filesystem support

## Common Operations

### Running Tests Locally
```bash
node test/test.js              # Run all tests
node test/test.js --filter="sync"  # Run tests matching "sync"
node test/fuzz-test.js         # Run fuzz tests
```

### Test Cleanup
The test suite automatically cleans up temporary files and databases. If manual cleanup is needed:
- Test database is created at `test/test_db_folder` during tests
- Automatically removed after test completion
