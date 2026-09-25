import { setFixedChecks } from "@cockfight/sim";

// Like the sim's own tests: any non-integer state field or division by zero throws.
setFixedChecks(true);
