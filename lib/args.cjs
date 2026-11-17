'use strict';

/**
 * Argument validation for model-supplied tool arguments.
 *
 * DeepSeek Harness hands a native tool its raw parsed arguments; the registry
 * knows the declared JSON Schema but does not enforce it. These helpers walk
 * the enforced-schema subset this bundle declares (type / properties /
 * required / additionalProperties / items / enum) and report every violation,
 * so one call surfaces all of a caller's mistakes at once.
 */

const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function describeValue(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

function typeMatches(type, value) {
  switch (type) {
  case 'string':
    return typeof value === 'string';
  case 'boolean':
    return typeof value === 'boolean';
  case 'number':
    return typeof value === 'number' && Number.isFinite(value);
  case 'integer':
    return typeof value === 'number' && Number.isInteger(value);
  case 'array':
    return Array.isArray(value);
  case 'object':
    return isPlainObject(value);
  case 'null':
    return value === null;
  default:
    return false;
  }
}

function articleFor(type) {
  return type === 'object' || type === 'array' || type === 'integer' ? `an ${type}` : `a ${type}`;
}

function joinPath(base, key) {
  return base === '' ? key : `${base}.${key}`;
}

function validateNode(schema, value, path, violations) {
  if (schema === null || schema === undefined || typeof schema !== 'object') {
    return;
  }

  if (schema.type !== undefined) {
    if (!SCHEMA_TYPES.has(schema.type)) {
      violations.push(`${path || 'arguments'} declares an unsupported schema type`);
      return;
    }
    if (!typeMatches(schema.type, value)) {
      violations.push(`${path || 'arguments'} must be ${articleFor(schema.type)}, got ${describeValue(value)}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path} must be one of ${schema.enum.map(entry => JSON.stringify(entry)).join(', ')}`);
  }

  if (schema.properties !== undefined && isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      const child = schema.properties[key];
      if (child === undefined) {
        if (schema.additionalProperties === false) {
          violations.push(`${joinPath(path, key)} is not a supported parameter`);
        }
        continue;
      }
      validateNode(child, value[key], joinPath(path, key), violations);
    }
  }

  if (schema.items !== undefined && Array.isArray(value)) {
    value.forEach((entry, index) => {
      validateNode(schema.items, entry, `${path}[${index}]`, violations);
    });
  }
}

/**
 * Validate one tool call's arguments against its declared parameter schema.
 * @param {object} parameters - declared parameter schema (JSON Schema subset).
 * @param {unknown} args - parsed model arguments.
 * @returns {string[]} path-qualified violations; empty means valid.
 */
function validateArguments(parameters, args) {
  if (!isPlainObject(args)) {
    return [`arguments must be a JSON object, got ${describeValue(args)}`];
  }

  const violations = [];
  validateNode(parameters, args, '', violations);

  const required = Array.isArray(parameters.required) ? parameters.required : [];
  for (const key of required) {
    const value = args[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      violations.push(`${key} is required`);
    }
  }

  return violations;
}

module.exports = {
  SCHEMA_TYPES,
  validateArguments,
};
