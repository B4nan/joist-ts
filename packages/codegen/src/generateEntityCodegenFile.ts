import { Table } from "pg-structure";
import { code, Code, imp } from "ts-poet";
import { EntityDbMetadata } from "./EntityDbMetadata";
import {
  Collection,
  EntityFilter,
  EntityManager,
  EntityOrmField,
  fail,
  FilterOf,
  Flavor,
  ManyToManyCollection,
  ManyToOneReference,
  OneToManyCollection,
  OrderBy,
  Reference,
  setField,
  setOpts,
  ValueFilter,
} from "./symbols";
import { camelCase } from "change-case";
import { SymbolSpec } from "ts-poet/build/SymbolSpecs";

export interface ColumnMetaData {
  typeConverter?: SymbolSpec;
  fieldType: SymbolSpec | string;
}

/** Creates the base class with the boilerplate annotations. */
export function generateEntityCodegenFile(table: Table, entityName: string): Code {
  const meta = new EntityDbMetadata(table);
  const entity = meta.entity;

  // Add the primitives
  const primitives = meta.primitives.map(p => {
    const { fieldName, fieldType, notNull } = p;
    const maybeOptional = notNull ? "" : " | undefined";
    const getter = code`
      get ${fieldName}(): ${fieldType}${maybeOptional} {
        return this.__orm.data["${fieldName}"];
      }
   `;
    const setter = code`
      set ${fieldName}(${fieldName}: ${fieldType}${maybeOptional}) {
        ${setField}(this, "${fieldName}", ${fieldName});
      }
    `;
    return code`${getter} ${!ormMaintainedFields.includes(fieldName) ? setter : ""}`;
  });

  // Add ManyToOne
  meta.enums.forEach(e => {
    const { fieldName, enumType, notNull } = e;
    const maybeOptional = notNull ? "" : " | undefined";
    const getter = code`
      get ${fieldName}(): ${enumType}${maybeOptional} {
        return this.__orm.data["${fieldName}"];
      }
   `;
    const setter = code`
      set ${fieldName}(${fieldName}: ${enumType}${maybeOptional}) {
        ${setField}(this, "${fieldName}", ${fieldName});
      }
    `;
    // Group enums as primitives
    primitives.push(getter);
    primitives.push(setter);
  });

  // Add ManyToOne
  const m2o = meta.manyToOnes.map(m2o => {
    const { fieldName, otherEntity, otherFieldName, notNull } = m2o;
    const maybeOptional = notNull ? "never" : "undefined";
    return code`
      readonly ${fieldName}: ${Reference}<${entity.type}, ${otherEntity.type}, ${maybeOptional}> =
        new ${ManyToOneReference}<${entity.type}, ${otherEntity.type}, ${maybeOptional}>(
          this as any,
          ${otherEntity.type},
          "${fieldName}",
          "${otherFieldName}",
          ${notNull},
        );
    `;
  });

  // Add OneToMany
  const o2m = meta.oneToManys.map(o2m => {
    const { fieldName, otherFieldName, otherColumnName, otherEntity } = o2m;
    return code`
      readonly ${fieldName}: ${Collection}<${entity.type}, ${otherEntity.type}> = new ${OneToManyCollection}(
        this as any,
        ${otherEntity.metaType},
        "${fieldName}",
        "${otherFieldName}",
        "${otherColumnName}"
      );
    `;
  });

  // Add ManyToMany
  const m2m = meta.manyToManys.map(m2m => {
    const { joinTableName, fieldName, columnName, otherEntity, otherFieldName, otherColumnName } = m2m;
    return code`
      readonly ${fieldName}: ${Collection}<${entity.type}, ${otherEntity.type}> = new ${ManyToManyCollection}(
        "${joinTableName}",
        this,
        "${fieldName}",
        "${columnName}",
        ${otherEntity.type},
        "${otherFieldName}",
        "${otherColumnName}",
      );
    `;
  });

  const metadata = imp(`${camelCase(entityName)}Meta@./entities`);

  return code`
    export type ${entityName}Id = ${Flavor}<string, "${entityName}">;

    export interface ${entityName}Opts {
      ${generateOptsFields(meta)}
    }

    export interface ${entityName}Filter {
      id?: ${ValueFilter}<${entityName}Id, never>;
      ${generateFilterFields(meta)}
    }

    export interface ${entityName}Order {
      id?: ${OrderBy};
      ${generateOrderFields(meta)}
    }

    export class ${entityName}Codegen {
      readonly __orm: ${EntityOrmField};
      readonly __filterType: ${entityName}Filter = null!;
      readonly __orderType: ${entityName}Order = null!;
      readonly __optsType: ${entityName}Opts = null!;
      ${[o2m, m2o, m2m]}
      
      constructor(em: ${EntityManager}, opts: ${entityName}Opts) {
        this.__orm = { em, metadata: ${metadata}, data: {}, originalData: {} };
        em.register(this);
        ${setOpts}(this, opts);
      }

      get id(): ${entityName}Id | undefined {
        return this.__orm.data["id"];
      }

      get idOrFail(): ${entityName}Id {
        return this.__orm.data["id"] || ${fail}("Entity has no id yet");
      }

      ${primitives}
      
      toString(): string {
        return "${entityName}#" + this.id;
      }

      set(opts: Partial<${entityName}Opts>): void {
        ${setOpts}(this, opts, false);
      }
    }
  `;
}

function generateOptsFields(meta: EntityDbMetadata): Code[] {
  // Make our opts type
  const primitives = meta.primitives.map(({ fieldName, fieldType, notNull }) => {
    if (ormMaintainedFields.includes(fieldName)) {
      return code``;
    }
    return code`${fieldName}${maybeOptional(notNull)}: ${fieldType}${maybeUnionNull(notNull)};`;
  });
  const enums = meta.enums.map(({ fieldName, enumType, notNull }) => {
    return code`${fieldName}${maybeOptional(notNull)}: ${enumType}${maybeUnionNull(notNull)};`;
  });
  const m2o = meta.manyToOnes.map(({ fieldName, otherEntity, notNull }) => {
    return code`${fieldName}${maybeOptional(notNull)}: ${otherEntity.type}${maybeUnionNull(notNull)};`;
  });
  const o2m = meta.oneToManys.map(({ fieldName, otherEntity }) => {
    return code`${fieldName}?: ${otherEntity.type}[];`;
  });
  const m2m = meta.manyToManys.map(({ fieldName, otherEntity }) => {
    return code`${fieldName}?: ${otherEntity.type}[];`;
  });
  return [...primitives, ...enums, ...m2o, ...o2m, ...m2m];
}

function generateFilterFields(meta: EntityDbMetadata): Code[] {
  // Make our opts type
  const primitives = meta.primitives.map(({ fieldName, fieldType, notNull }) => {
    return code`${fieldName}?: ${ValueFilter}<${fieldType}, ${nullOrNever(notNull)}>;`;
  });
  const enums = meta.enums.map(({ fieldName, enumType, notNull }) => {
    return code`${fieldName}?: ${ValueFilter}<${enumType}, ${nullOrNever(notNull)}>;`;
  });
  const m2o = meta.manyToOnes.map(({ fieldName, otherEntity, notNull }) => {
    return code`${fieldName}?: ${EntityFilter}<${otherEntity.type}, ${otherEntity.idType}, ${FilterOf}<${
      otherEntity.type
    }>, ${nullOrNever(notNull)}>;`;
  });
  return [...primitives, ...enums, ...m2o];
}

function generateOrderFields(meta: EntityDbMetadata): Code[] {
  // Make our opts type
  const primitives = meta.primitives.map(({ fieldName }) => {
    return code`${fieldName}?: ${OrderBy};`;
  });
  const enums = meta.enums.map(({ fieldName }) => {
    return code`${fieldName}?: ${OrderBy};`;
  });
  const m2o = meta.manyToOnes.map(({ fieldName, otherEntity, notNull }) => {
    return code`${fieldName}?: ${otherEntity.orderType};`;
  });
  return [...primitives, ...enums, ...m2o];
}

function maybeOptional(notNull: boolean): string {
  return notNull ? "" : "?";
}

function maybeUnionNull(notNull: boolean): string {
  return notNull ? "" : " | null";
}

function nullOrNever(notNull: boolean): string {
  return notNull ? "never" : " null | undefined";
}

const ormMaintainedFields = ["createdAt", "updatedAt"];
