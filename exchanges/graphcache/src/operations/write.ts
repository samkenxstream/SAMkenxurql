import { CombinedError } from '@urql/core';

import {
  FieldNode,
  DocumentNode,
  FragmentDefinitionNode,
} from '@0no-co/graphql.web';

import {
  getFragments,
  getMainOperation,
  normalizeVariables,
  getFieldArguments,
  isFieldAvailableOnType,
  getSelectionSet,
  getName,
  SelectionSet,
  getFragmentTypeName,
  getFieldAlias,
} from '../ast';

import { invariant, warn, pushDebugNode, popDebugNode } from '../helpers/help';

import {
  NullArray,
  Variables,
  Data,
  Link,
  OperationRequest,
  Dependencies,
  EntityField,
  OptimisticMutationResolver,
} from '../types';

import { joinKeys, keyOfField } from '../store/keys';
import { Store } from '../store/store';
import * as InMemoryData from '../store/data';

import {
  Context,
  makeSelectionIterator,
  ensureData,
  makeContext,
  updateContext,
  getFieldError,
  deferRef,
} from './shared';

export interface WriteResult {
  data: null | Data;
  dependencies: Dependencies;
}

/** Writes a GraphQL response to the cache.
 * @internal
 */
export const __initAnd_write = (
  store: Store,
  request: OperationRequest,
  data: Data,
  error?: CombinedError | undefined,
  key?: number
): WriteResult => {
  InMemoryData.initDataState('write', store.data, key || null);
  const result = _write(store, request, data, error);
  InMemoryData.clearDataState();
  return result;
};

export const __initAnd_writeOptimistic = (
  store: Store,
  request: OperationRequest,
  key: number
): WriteResult => {
  if (process.env.NODE_ENV !== 'production') {
    invariant(
      getMainOperation(request.query).operation === 'mutation',
      'writeOptimistic(...) was called with an operation that is not a mutation.\n' +
        'This case is unsupported and should never occur.',
      10
    );
  }

  InMemoryData.initDataState('write', store.data, key, true);
  const result = _write(store, request, {} as Data, undefined);
  InMemoryData.clearDataState();
  return result;
};

export const _write = (
  store: Store,
  request: OperationRequest,
  data?: Data,
  error?: CombinedError | undefined
) => {
  if (process.env.NODE_ENV !== 'production') {
    InMemoryData.getCurrentDependencies();
  }

  const operation = getMainOperation(request.query);
  const result: WriteResult = {
    data: data || InMemoryData.makeData(),
    dependencies: InMemoryData.currentDependencies!,
  };
  const kind = store.rootFields[operation.operation];

  const ctx = makeContext(
    store,
    normalizeVariables(operation, request.variables),
    getFragments(request.query),
    kind,
    kind,
    error
  );

  if (process.env.NODE_ENV !== 'production') {
    pushDebugNode(kind, operation);
  }

  writeSelection(ctx, kind, getSelectionSet(operation), result.data!);

  if (process.env.NODE_ENV !== 'production') {
    popDebugNode();
  }

  return result;
};

export const _writeFragment = (
  store: Store,
  query: DocumentNode,
  data: Partial<Data>,
  variables?: Variables,
  fragmentName?: string
) => {
  const fragments = getFragments(query);
  let fragment: FragmentDefinitionNode;
  if (fragmentName) {
    fragment = fragments[fragmentName] as FragmentDefinitionNode;
    if (!fragment) {
      warn(
        'writeFragment(...) was called with a fragment name that does not exist.\n' +
          'You provided ' +
          fragmentName +
          ' but could only find ' +
          Object.keys(fragments).join(', ') +
          '.',
        11
      );

      return null;
    }
  } else {
    const names = Object.keys(fragments);
    fragment = fragments[names[0]] as FragmentDefinitionNode;
    if (!fragment) {
      warn(
        'writeFragment(...) was called with an empty fragment.\n' +
          'You have to call it with at least one fragment in your GraphQL document.',
        11
      );

      return null;
    }
  }

  const typename = getFragmentTypeName(fragment);
  const dataToWrite = { __typename: typename, ...data } as Data;
  const entityKey = store.keyOfEntity(dataToWrite);
  if (!entityKey) {
    return warn(
      "Can't generate a key for writeFragment(...) data.\n" +
        'You have to pass an `id` or `_id` field or create a custom `keys` config for `' +
        typename +
        '`.',
      12
    );
  }

  if (process.env.NODE_ENV !== 'production') {
    pushDebugNode(typename, fragment);
  }

  const ctx = makeContext(
    store,
    variables || {},
    fragments,
    typename,
    entityKey,
    undefined
  );

  writeSelection(ctx, entityKey, getSelectionSet(fragment), dataToWrite);

  if (process.env.NODE_ENV !== 'production') {
    popDebugNode();
  }
};

const writeSelection = (
  ctx: Context,
  entityKey: undefined | string,
  select: SelectionSet,
  data: Data
) => {
  // These fields determine how we write. The `Query` root type is written
  // like a normal entity, hence, we use `rootField` with a default to determine
  // this. All other root names (Subscription & Mutation) are in a different
  // write mode
  const rootField = ctx.store.rootNames[entityKey!] || 'query';
  const isRoot = !!ctx.store.rootNames[entityKey!];

  const typename = isRoot ? entityKey : data.__typename;
  if (!typename) {
    warn(
      "Couldn't find __typename when writing.\n" +
        "If you're writing to the cache manually have to pass a `__typename` property on each entity in your data.",
      14
    );
    return;
  } else if (!isRoot && entityKey) {
    InMemoryData.writeRecord(entityKey, '__typename', typename);
  }

  const updates = ctx.store.updates[typename];
  const iterate = makeSelectionIterator(
    typename,
    entityKey || typename,
    deferRef,
    select,
    ctx
  );

  let node: FieldNode | void;
  while ((node = iterate())) {
    const fieldName = getName(node);
    const fieldArgs = getFieldArguments(node, ctx.variables);
    const fieldKey = keyOfField(fieldName, fieldArgs);
    const fieldAlias = getFieldAlias(node);
    let fieldValue = data[ctx.optimistic ? fieldName : fieldAlias];

    // Development check of undefined fields
    if (process.env.NODE_ENV !== 'production') {
      if (
        rootField === 'query' &&
        fieldValue === undefined &&
        !deferRef &&
        !ctx.optimistic
      ) {
        const expected =
          node.selectionSet === undefined
            ? 'scalar (number, boolean, etc)'
            : 'selection set';

        warn(
          'Invalid undefined: The field at `' +
            fieldKey +
            '` is `undefined`, but the GraphQL query expects a ' +
            expected +
            ' for this field.',
          13
        );

        continue; // Skip this field
      } else if (ctx.store.schema && typename && fieldName !== '__typename') {
        isFieldAvailableOnType(ctx.store.schema, typename, fieldName);
      }
    }

    if (
      // Skip typename fields and assume they've already been written above
      fieldName === '__typename' ||
      // Fields marked as deferred that aren't defined must be skipped
      // Otherwise, we also ignore undefined values in optimistic updaters
      (fieldValue === undefined &&
        (deferRef || (ctx.optimistic && rootField === 'query')))
    ) {
      continue;
    }

    // Add the current alias to the walked path before processing the field's value
    ctx.__internal.path.push(fieldAlias);

    // Execute optimistic mutation functions on root fields, or execute recursive functions
    // that have been returned on optimistic objects
    let resolver: OptimisticMutationResolver | void;
    if (ctx.optimistic && rootField === 'mutation') {
      resolver = ctx.store.optimisticMutations[fieldName];
      if (!resolver) continue;
    } else if (ctx.optimistic && typeof fieldValue === 'function') {
      resolver = fieldValue as any;
    }

    // Execute the field-level resolver to retrieve its data
    if (resolver) {
      // We have to update the context to reflect up-to-date ResolveInfo
      updateContext(ctx, data, typename, typename, fieldKey, fieldName);
      fieldValue = ensureData(resolver(fieldArgs || {}, ctx.store, ctx));
    }

    if (node.selectionSet) {
      // Process the field and write links for the child entities that have been written
      if (entityKey && rootField === 'query') {
        const key = joinKeys(entityKey, fieldKey);
        const link = writeField(
          ctx,
          getSelectionSet(node),
          ensureData(fieldValue),
          key
        );
        InMemoryData.writeLink(entityKey || typename, fieldKey, link);
      } else {
        writeField(ctx, getSelectionSet(node), ensureData(fieldValue));
      }
    } else if (entityKey && rootField === 'query') {
      // This is a leaf node, so we're setting the field's value directly
      InMemoryData.writeRecord(
        entityKey || typename,
        fieldKey,
        (fieldValue !== null || !getFieldError(ctx)
          ? fieldValue
          : undefined) as EntityField
      );
    }

    // We run side-effect updates after the default, normalized updates
    // so that the data is already available in-store if necessary
    const updater = updates && updates[fieldName];
    if (updater) {
      // We have to update the context to reflect up-to-date ResolveInfo
      updateContext(
        ctx,
        data,
        typename,
        typename,
        joinKeys(typename, fieldKey),
        fieldName
      );

      data[fieldName] = fieldValue;
      updater(data, fieldArgs || {}, ctx.store, ctx);
    }

    // After processing the field, remove the current alias from the path again
    ctx.__internal.path.pop();
  }
};

// A pattern to match typenames of types that are likely never keyable
const KEYLESS_TYPE_RE = /^__|PageInfo|(Connection|Edge)$/;

const writeField = (
  ctx: Context,
  select: SelectionSet,
  data: null | Data | NullArray<Data>,
  parentFieldKey?: string
): Link | undefined => {
  if (Array.isArray(data)) {
    const newData = new Array(data.length);
    for (let i = 0, l = data.length; i < l; i++) {
      // Add the current index to the walked path before processing the link
      ctx.__internal.path.push(i);
      // Append the current index to the parentFieldKey fallback
      const indexKey = parentFieldKey
        ? joinKeys(parentFieldKey, `${i}`)
        : undefined;
      // Recursively write array data
      const links = writeField(ctx, select, data[i], indexKey);
      // Link cannot be expressed as a recursive type
      newData[i] = links as string | null;
      // After processing the field, remove the current index from the path
      ctx.__internal.path.pop();
    }

    return newData;
  } else if (data === null) {
    return getFieldError(ctx) ? undefined : null;
  }

  const entityKey = ctx.store.keyOfEntity(data);
  const typename = data.__typename;

  if (
    parentFieldKey &&
    !ctx.store.keys[data.__typename] &&
    entityKey === null &&
    typeof typename === 'string' &&
    !KEYLESS_TYPE_RE.test(typename)
  ) {
    warn(
      'Invalid key: The GraphQL query at the field at `' +
        parentFieldKey +
        '` has a selection set, ' +
        'but no key could be generated for the data at this field.\n' +
        'You have to request `id` or `_id` fields for all selection sets or create ' +
        'a custom `keys` config for `' +
        typename +
        '`.\n' +
        'Entities without keys will be embedded directly on the parent entity. ' +
        'If this is intentional, create a `keys` config for `' +
        typename +
        '` that always returns null.',
      15
    );
  }

  const childKey = entityKey || parentFieldKey;
  writeSelection(ctx, childKey, select, data);
  return childKey || null;
};
