import { calculate } from "./math";

@Controller("users")
export class UsersController {
  @Get(":id")
  getOne() {
    return calculate(1);
  }
}
