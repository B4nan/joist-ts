import { Entity, EntityMetadata } from "./EntityManager";
import Knex, { Transaction } from "knex";
import { keyToNumber, keyToString, maybeResolveReferenceToId } from "./serde";
import { JoinRow } from "./collections/ManyToManyCollection";

export interface Todo {
  metadata: EntityMetadata<any>;
  inserts: Entity[];
  updates: Entity[];
  deletes: Entity[];
}

export async function flushEntities(knex: Knex, tx: Transaction, todos: Todo[]): Promise<void> {
  const updatedAt = new Date();
  for await (const todo of todos) {
    if (todo) {
      const meta = todo.metadata;
      if (todo.inserts.length > 0) {
        await batchInsert(knex, tx, meta, todo.inserts);
      }
      if (todo.updates.length > 0) {
        todo.updates.forEach(e => (e.__orm.data["updatedAt"] = updatedAt));
        await batchUpdate(knex, tx, meta, todo.updates);
      }
      if (todo.deletes.length > 0) {
        await batchDelete(knex, tx, meta, todo.deletes);
      }
    }
  }
}

async function batchInsert(knex: Knex, tx: Transaction, meta: EntityMetadata<any>, entities: Entity[]): Promise<void> {
  const rows = entities.map(entity => {
    const row = {};
    meta.columns.forEach(c => c.serde.setOnRow(entity.__orm.data, row));
    return row;
  });
  const ids = await knex
    .batchInsert(meta.tableName, rows)
    .transacting(tx)
    .returning("id");
  for (let i = 0; i < entities.length; i++) {
    entities[i].__orm.data["id"] = keyToString(ids[i]);
    entities[i].__orm.originalData = {};
  }
}

// Uses a pg-specific syntax to issue a bulk update
async function batchUpdate(knex: Knex, tx: Transaction, meta: EntityMetadata<any>, entities: Entity[]): Promise<void> {
  // Get the unique set of fields that are changed across all of the entities (of this type) we want to bulk update
  const changedFields = new Set<string>();
  // Id doesn't change, but we need it for our WHERE clause
  changedFields.add("id");
  entities.forEach(entity => {
    Object.keys(entity.__orm.originalData).forEach(key => changedFields.add(key));
  });

  // This currently assumes a 1-to-1 field-to-column mapping.
  const columns = meta.columns.filter(c => changedFields.has(c.fieldName));
  const bindings: any[][] = columns.map(() => []);
  for (const entity of entities) {
    columns.forEach((c, i) => {
      bindings[i].push(c.serde.getFromEntity(entity.__orm.data) ?? null);
    });
  }
  await knex
    .raw(
      cleanSql(`
      UPDATE ${meta.tableName}
      SET ${columns
        .filter(c => c.columnName !== "id")
        .map(c => `${c.columnName} = data.${c.columnName}`)
        .join(", ")}
      FROM (select ${columns.map(c => `unnest(?::${c.dbType}[]) as ${c.columnName}`).join(", ")}) as data
      WHERE ${meta.tableName}.id = data.id
   `),
      bindings,
    )
    .transacting(tx);
  entities.forEach(entity => (entity.__orm.originalData = {}));
}

async function batchDelete(knex: Knex, tx: Transaction, meta: EntityMetadata<any>, entities: Entity[]): Promise<void> {
  await knex(meta.tableName)
    .del()
    .whereIn(
      "id",
      entities.map(e => e.id!),
    )
    .transacting(tx);
  entities.forEach(entity => (entity.__orm.deleted = "deleted"));
}

function cleanSql(sql: string): string {
  return sql
    .trim()
    .replace(/\n/g, "")
    .replace(/  +/g, " ");
}

/**
 * Scans `entities` for new/updated entities and arranges them per-type in entity order.
 *
 * This currently assumes the entity types in the schema can be topographically sorted
 * and have no cycles, i.e. `books` always depend on `authors` (due to the `books.author_id`
 * foreign key), but `authors` never (via a required foreign key) depend on `books`.
 */
export function sortEntities(entities: Entity[]): Todo[] {
  const todos: Todo[] = [];
  for (const entity of entities) {
    const order = entity.__orm.metadata.order;
    const isNew = entity.id === undefined;
    const isDirty = !isNew && Object.keys(entity.__orm.originalData).length > 0;
    const isDelete = !isNew && entity.__orm.deleted === "pending";
    if (isNew || isDirty || isDelete) {
      let todo = todos[order];
      if (!todo) {
        todo = { metadata: entity.__orm.metadata, inserts: [], updates: [], deletes: [] };
        todos[order] = todo;
      }
      if (isNew) {
        todo.inserts.push(entity);
      } else if (isDelete) {
        todo.deletes.push(entity);
      } else {
        todo.updates.push(entity);
      }
    }
  }
  return todos;
}

export async function flushJoinTables(
  knex: Knex,
  tx: Transaction,
  joinRows: Record<string, JoinRowTodo>,
): Promise<void> {
  for await (const [joinTableName, { newRows, deletedRows }] of Object.entries(joinRows)) {
    if (newRows.length > 0) {
      const ids = await knex
        .batchInsert(
          joinTableName,
          newRows.map(row => {
            // The rows in EntityManager.joinRows point to entities, change those to ints
            const { id, created_at, ...fkColumns } = row;
            Object.keys(fkColumns).forEach(key => {
              fkColumns[key] = keyToNumber(maybeResolveReferenceToId(fkColumns[key]));
            });
            return fkColumns;
          }),
        )
        .transacting(tx)
        .returning("id");
      for (let i = 0; i < ids.length; i++) {
        newRows[i].id = ids[i];
      }
    }
    if (deletedRows.length > 0) {
      await knex(joinTableName)
        .del()
        .whereIn(
          "id",
          deletedRows.map(e => e.id!),
        )
        .transacting(tx);
    }
  }
}

interface JoinRowTodo {
  newRows: JoinRow[];
  deletedRows: JoinRow[];
}

export function sortJoinRows(joinRows: Record<string, JoinRow[]>): Record<string, JoinRowTodo> {
  const todos: Record<string, JoinRowTodo> = {};
  for (const [joinTableName, rows] of Object.entries(joinRows)) {
    const newRows = rows.filter(r => r.id === undefined && r.deleted !== true);
    const deletedRows = rows.filter(r => r.id !== undefined && r.deleted === true);
    if (newRows.length > 0 || deletedRows.length > 0) {
      todos[joinTableName] = { newRows, deletedRows };
    }
  }
  return todos;
}
