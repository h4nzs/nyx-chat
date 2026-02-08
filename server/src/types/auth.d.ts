// Defines the shape of the JWT payload and the user object attached to the request

export interface AuthPayload {
  id: string;
  username: string;
  email: string;
}
