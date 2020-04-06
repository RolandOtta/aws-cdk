// ----------------------------------------------------
// CROSS REFERENCES
// ----------------------------------------------------
import { CfnElement } from '../cfn-element';
import { CfnOutput } from '../cfn-output';
import { CfnParameter } from '../cfn-parameter';
import { Construct } from '../construct-compat';
import { Reference } from '../reference';
import { IResolvable } from '../resolvable';
import { Stack } from '../stack';
import { Token } from '../token';
import { CfnReference } from './cfn-reference';
import { Intrinsic } from './intrinsic';
import { findTokens } from './resolve';
import { makeUniqueId } from './uniqueid';

/**
 * This is called from the App level to resolve all references defined. Each
 * reference is resolved based on it's consumption context.
 */
export function resolveReferences(scope: Construct) {
  const edges = findAllReferences(scope);

  for (const { source, value } of edges) {
    const consumer = Stack.of(source);

    // skip if we already have a value for this consumer
    if (value.hasValueForStack(consumer)) {
      continue;
    }

    // resolve the value in the context of the consumer.
    const resolved = resolveValue(consumer, value);
    value.assignValueForStack(consumer, resolved);
  }
}

/**
 * Resolves the value for `reference` in the context of `consumer`.
 */
function resolveValue(consumer: Stack, reference: CfnReference): IResolvable {
  const producer = Stack.of(reference.target);

  // produce and consumer stacks are the same, we can just return the value itself.
  if (producer === consumer) {
    return reference;
  }

  // unsupported: stacks from different apps
  if (producer.node.root !== consumer.node.root) {
    throw new Error('Cannot reference across apps. Consuming and producing stacks must be defined within the same CDK app.');
  }

  // unsupported: stacks are not in the same environment
  if (producer.environment !== consumer.environment) {
    throw new Error(
      `Stack "${consumer.node.path}" cannot consume a cross reference from stack "${producer.node.path}". ` +
      'Cross stack references are only supported for stacks deployed to the same environment or between nested stacks and their parent stack');
  }

  // ----------------------------------------------------------------------
  // consumer is nested in the producer (directly or indirectly)
  // ----------------------------------------------------------------------

  // if the consumer is a child of the producer, wire the reference through a
  // CloudFormation parameter on the consumer and resolve recursively.
  if (isParent(producer, consumer)) {
    const parameterValue = createNestedStackParameter(consumer, reference);
    return resolveValue(consumer, parameterValue);
  }

  // ----------------------------------------------------------------------
  // producer is a nested stack
  // ----------------------------------------------------------------------

  // if the producer is nested, always publish the value through a
  // cloudformation output and resolve recursively with the Fn::GetAtt
  // of the output in the parent stack.

  // one might ask, if the consumer is not a parent of the producer,
  // why not just use export/import? the reason is that we cannot
  // generate an "export name" from a nested stack because the export
  // name must contain the stack name to ensure uniqueness, and we
  // don't know the stack name of a nested stack before we deploy it.
  // therefore, we can only export from a top-level stack.
  if (producer.nested) {
    const outputValue = createNestedStackOutput(producer, reference);
    return resolveValue(consumer, outputValue);
  }

  // ----------------------------------------------------------------------
  // export/import
  // ----------------------------------------------------------------------

  // export the value through a cloudformation "export name" and use an
  // Fn::ImportValue in the consumption site.

  // delcare a dependency between the two top-level (non-nested) stacks to make
  // sure the producer is deployed before the consumer.
  const producerDep = producer.nestedStackParent ?? producer;
  const consumerDep = consumer.nestedStackParent ?? consumer;
  consumerDep.addDependency(producerDep,
    `${consumer.node.path} -> ${reference.target.node.path}.${reference.displayName}`);

  return createImportValue(reference);
}

/**
 * Finds all the CloudFormation references in a construct tree.
 */
function findAllReferences(root: Construct) {
  const result = new Array<{ source: CfnElement, value: CfnReference }>();
  for (const consumer of root.node.findAll()) {

    // include only CfnElements (i.e. resources)
    if (!CfnElement.isCfnElement(consumer)) {
      continue;
    }

    try {
      const tokens = findTokens(consumer, () => consumer._toCloudFormation());

      // iterate over all the tokens (e.g. intrinsic functions, lazies, etc) that
      // were found in the cloudformation representation of this resource.
      for (const token of tokens) {

        // include only CfnReferences (i.e. "Ref" and "Fn::GetAtt")
        if (!CfnReference.isCfnReference(token)) {
          continue;
        }

        result.push({
          source: consumer,
          value: token
        });
      }
    }  catch (e) {
      // Note: it might be that the properties of the CFN object aren't valid.
      // This will usually be preventatively caught in a construct's validate()
      // and turned into a nicely descriptive error, but we're running prepare()
      // before validate(). Swallow errors that occur because the CFN layer
      // doesn't validate completely.
      //
      // This does make the assumption that the error will not be rectified,
      // but the error will be thrown later on anyway. If the error doesn't
      // get thrown down the line, we may miss references.
      if (e.type === 'CfnSynthesisError') {
        continue;
      }

      throw e;
    }
  }

  return result;
}

// ------------------------------------------------------------------------------------------------
// export/import
// ------------------------------------------------------------------------------------------------

/**
 * Imports a value from another stack by creating an "Output" with an "ExportName"
 * and returning an "Fn::ImportValue" token.
 */
function createImportValue(reference: Reference): IResolvable {
  const exportingStack = Stack.of(reference.target);

  // Ensure a singleton "Exports" scoping Construct
  // This mostly exists to trigger LogicalID munging, which would be
  // disabled if we parented constructs directly under Stack.
  // Also it nicely prevents likely construct name clashes
  const exportsScope = getCreateExportsScope(exportingStack);

  // Ensure a singleton CfnOutput for this value
  const resolved = exportingStack.resolve(reference);
  const id = 'Output' + JSON.stringify(resolved);
  const exportName = generateExportName(exportsScope, id);

  if (Token.isUnresolved(exportName)) {
    throw new Error(`unresolved token in generated export name: ${JSON.stringify(exportingStack.resolve(exportName))}`);
  }

  const output = exportsScope.node.tryFindChild(id) as CfnOutput;
  if (!output) {
    new CfnOutput(exportsScope, id, { value: Token.asString(reference), exportName });
  }

  // We want to return an actual FnImportValue Token here, but Fn.importValue() returns a 'string',
  // so construct one in-place.
  return new Intrinsic({ 'Fn::ImportValue': exportName });
}

function getCreateExportsScope(stack: Stack) {
  const exportsName = 'Exports';
  let stackExports = stack.node.tryFindChild(exportsName) as Construct;
  if (stackExports === undefined) {
    stackExports = new Construct(stack, exportsName);
  }

  return stackExports;
}

function generateExportName(stackExports: Construct, id: string) {
  const stack = Stack.of(stackExports);
  const components = [...stackExports.node.scopes.slice(2).map(c => c.node.id), id];
  const prefix = stack.stackName ? stack.stackName + ':' : '';
  const exportName = prefix + makeUniqueId(components);
  return exportName;
}

// ------------------------------------------------------------------------------------------------
// nested stacks
// ------------------------------------------------------------------------------------------------

/**
 * Adds a CloudFormation parameter to a nested stack and assigns it with the
 * value of the reference.
 */
function createNestedStackParameter(consumer: Stack, reference: Reference) {
  // we call "this.resolve" to ensure that tokens do not creep in (for example, if the reference display name includes tokens)
  const paramId = consumer.resolve(`reference-to-${reference.target.node.uniqueId}.${reference.displayName}`);
  let param = consumer.node.tryFindChild(paramId) as CfnParameter;
  if (!param) {
    param = new CfnParameter(consumer, paramId, { type: 'String' });

    // Ugly little hack until we move NestedStack to this module.
    if (!('setParameter' in consumer)) {
      throw new Error('assertion failed: nested stack should have a "setParameter" method');
    }

    (consumer as any).setParameter(param.logicalId, Token.asString(reference));
  }

  return param.value as CfnReference;
}

/**
 * Adds a CloudFormation output to a nested stack and returns an "Fn::GetAtt"
 * intrinsic that can be used to reference this output in the parent stack.
 */
function createNestedStackOutput(producer: Stack, reference: Reference): CfnReference {
  const outputId = `${reference.target.node.uniqueId}${reference.displayName}`;
  let output = producer.node.tryFindChild(outputId) as CfnOutput;
  if (!output) {
    output = new CfnOutput(producer, outputId, { value: Token.asString(reference) });
  }

  if (!producer.nestedStackResource) {
    throw new Error('assertion failed');
  }

  return producer.nestedStackResource.getAtt(`Outputs.${output.logicalId}`) as CfnReference;
}

/**
 * @returns true if this stack is a direct or indirect parent of the nested
 * stack `nested`.
 *
 * If `child` is not a nested stack, always returns `false` because it can't
 * have a parent, dah.
 */
export function isParent(parent: Stack, child: Stack): boolean {
  // if "nested" is not a nested stack, then by definition we cannot be its parent
  if (!child.nestedStackParent) {
    return false;
  }

  // if this is the direct parent, then we found it
  if (parent === child.nestedStackParent) {
    return true;
  }

  // traverse up
  return isParent(parent, child.nestedStackParent);
}
