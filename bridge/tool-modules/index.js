'use strict';

// Register additional tool modules here. Each module exports a dependency-injected
// factory returning { definition, requiresConfirmation?, execute } entries.
module.exports = function toolModules(dependencies) {
  return [require('./git')(dependencies), require('./github')(dependencies)];
};
