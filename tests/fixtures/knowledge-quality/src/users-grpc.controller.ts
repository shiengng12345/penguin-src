import { calculate } from "./math";

@Controller()
export class UsersGrpcController {
  @GrpcMethod('UsersService', 'GetUser')
  getUser() {
    return calculate(2);
  }
}
