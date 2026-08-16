import type { TypedValue, VerifierLanguage } from "../description.js";

/**
 * Source-side callable metadata. Java and C# use className directly; Python
 * and TypeScript additionally need the module that exports the callable.
 */
export interface SourceInvocation {
  language: VerifierLanguage;
  module?: string;
  className?: string;
  method: string;
  isStatic: boolean;
  constructorArgs: TypedValue[];
}
