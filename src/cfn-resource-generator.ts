import { pascal } from 'case';
import * as j2j from 'json2jsii';
import { TypeGenerator } from 'json2jsii';
import { TypeInfo } from './type-info';
import { sanitizeTypeName } from './util';

/**
 * Generator to emit classes and types for the L1 construct of the given resource type
 */
export class CfnResourceGenerator {

  private readonly sanitizedTypeName: string;
  private readonly resourceAttributes: string[];
  private readonly resourceProperties: string[];
  private readonly constructClassName: string;
  private readonly propsStructName: string;

  /**
   *
   * @param typeName the name of the CFN resource type (e.g. AWSQS::EKS::Cluster)
   * @param typeDef the type info containing the source url
   * @param schema the schema of the resource type for input and output properties
   */
  constructor(private readonly typeName: string, private readonly typeDef: TypeInfo, private readonly schema: any) {
    this.sanitizedTypeName = sanitizeTypeName(typeName);
    // this.resourceAttributes = this.schema.readOnlyProperties ? this.schema.readOnlyProperties.map((prop: string) => prop.replace(/^\/properties\//, '')) : [];
    // this.resourceProperties = Object.keys(this.schema.properties).filter(prop => this.resourceAttributes.indexOf(prop) === -1);
    this.constructClassName = TypeGenerator.normalizeTypeName(`Cfn${this.sanitizedTypeName}`);
    this.propsStructName = TypeGenerator.normalizeTypeName(`${this.constructClassName}Props`);

    this.resourceAttributes = new Array<string>();
    this.resourceProperties = new Array<string>();

    const props = this.schema.properties ?? {};
    const attributeNames: string[] = this.schema.readOnlyProperties
      ? this.schema.readOnlyProperties.map((prop: string) => prop.replace(/^\/properties\//, ''))
      : [];

    for (const attr of attributeNames) {
      const def = props[attr];
      if (!def) {
        console.warn(`Unresolvable read-only property (attribute) ${typeName}.${attr}`);
        continue;
      }

      // verify that the type of the attribute is a primitive
      if (def.type !== 'string' && def.type !== 'number') {
        console.warn(`Unsupported type ${JSON.stringify(def)} for read-only property (attribute) ${typeName}.${attr}`);
        continue;
      }

      this.resourceAttributes.push(attr);
    }

    for (const prop of Object.keys(props)) {
      // if this is a read-only property, consider it an attribute
      if (attributeNames.includes(prop)) {
        continue;
      }

      this.resourceProperties.push(prop);
    }
  }

  /**
   * Render the type into a TypeScript class fil defining the props and the L1 construct
   *
   * @returns the rendered class file content
   */
  public render(): string {
    const code = new j2j.Code();
    this.emitImports(code);
    this.emitDefinitionTypes(code);
    this.emitConstructClass(code);
    return code.render();
  }

  private emitImports(code: j2j.Code) {
    code.line('// Generated by cdk-import');
    code.line("import * as cdk from 'aws-cdk-lib';");
    code.line("import * as constructs from 'constructs';");
    code.line();
  }

  private emitDefinitionTypes(code: j2j.Code) {
    const gen = new j2j.TypeGenerator({
      definitions: this.schema.definitions,
    });

    const schema = JSON.parse(JSON.stringify(this.schema));
    for (const prop of this.resourceAttributes) {
      // Remove attributes that cannot be written but are used as attributes
      // These should not be part of the Props struct
      delete schema.properties[prop];
    }

    gen.emitType(this.propsStructName, schema);

    gen.renderToCode(code);
    code.line();
  }

  private emitConstructClass(code: j2j.Code) {
    code.line('/**');
    code.line(` * A CloudFormation \`${this.typeName}\``);
    code.line(' *');
    code.line(` * @cloudformationResource ${this.typeName}`);
    code.line(' * @stability external');
    if (this.typeDef.SourceUrl) {
      code.line(` * @link ${this.typeDef.SourceUrl}`);
    }
    code.line(' */');
    code.openBlock(`export class ${this.constructClassName} extends cdk.CfnResource`);
    code.line('/**');
    code.line('* The CloudFormation resource type name for this resource class.');
    code.line('*/');
    code.line(`public static readonly CFN_RESOURCE_TYPE_NAME = "${this.typeName}";`);
    code.line();

    // emit a "props" property which includes the set of props passed to the constructor
    code.line('/**');
    code.line(' * Resource props.');
    code.line(' */');
    code.line(`public readonly props: ${this.propsStructName};`);
    code.line();

    for (const prop of this.resourceAttributes) {
      code.line('/**');
      code.line(` * Attribute \`${this.typeName}.${prop}\``);
      if (this.typeDef.SourceUrl) {
        code.line(` * @link ${this.typeDef.SourceUrl}`);
      }
      code.line(' */');
      code.line(`public readonly attr${pascal(prop)}: ${this.getTypeOfProperty(prop)};`);
    }

    code.line();

    code.line('/**');
    code.line(` * Create a new \`${this.typeName}\`.`);
    code.line(' *');
    code.line(' * @param scope - scope in which this resource is defined');
    code.line(' * @param id    - scoped id of the resource');
    code.line(' * @param props - resource properties');
    code.line(' */');
    code.openBlock(`constructor(scope: constructs.Construct, id: string, props: ${this.propsStructName})`);
    code.line(`super(scope, id, { type: ${this.constructClassName}.CFN_RESOURCE_TYPE_NAME, properties: toJson_${this.propsStructName}(props)! });`);
    code.line('');
    code.line('this.props = props;');
    code.line();
    for (const prop of this.resourceAttributes) {
      const propertyName = `attr${pascal(prop)}`;
      code.line(`this.${propertyName} = ${this.renderGetAtt(prop)};`);
    }
    code.closeBlock();

    // Close construct class
    code.closeBlock();
  }

  private renderGetAtt(prop: string): string {
    const attributeType = this.getTypeOfProperty(prop);
    const constructorArguments = `this.getAtt('${prop}')`;
    if (attributeType === 'string') {
      return `cdk.Token.asString(${constructorArguments})`;
    }
    if (attributeType === 'string[]') {
      return `cdk.Token.asList(${constructorArguments})`;
    }
    if (attributeType === 'number') {
      return `cdk.Token.asNumber(${constructorArguments})`;
    }
    return constructorArguments;
  }

  private getTypeOfProperty(prop: string) {
    return this.getTypeFromSchema(this.schema.properties[prop]);
  }

  private getTypeFromSchema(prop: any): string {
    if (prop.type) {
      switch (prop.type) {
        case 'string':
          return 'string';
        case 'array':
          return `${this.getTypeFromSchema(prop.items)}[]`;
        case 'number':
          return 'number';
        case 'integer':
          return 'number';
        default:
          return 'any';
      }
    }
    if (prop.hasOwnProperty('$ref')) {
      return prop.$ref.replace(/#\/definitions\//, '');
    }
    return 'any';
  }

}
