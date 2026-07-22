from pydantic import BaseModel, ConfigDict, EmailStr

from app.auth.models import UserRole


class UserRegister(BaseModel):
    email: EmailStr
    password: str
    role: UserRole = UserRole.ANNOTATOR


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class UserRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    role: UserRole


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
