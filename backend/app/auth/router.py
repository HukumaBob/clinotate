from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.auth.dependencies import get_current_user
from app.auth.models import User
from app.auth.schemas import TokenResponse, UserLogin, UserRead, UserRegister
from app.auth.service import create_access_token, hash_password, verify_password
from app.db import get_session

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", response_model=UserRead, status_code=status.HTTP_201_CREATED)
def register(payload: UserRegister, session: Session = Depends(get_session)) -> User:
    user = User(email=payload.email, hashed_password=hash_password(payload.password), role=payload.role)
    session.add(user)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered") from exc
    session.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
def login(payload: UserLogin, session: Session = Depends(get_session)) -> TokenResponse:
    user = session.query(User).filter(User.email == payload.email).first()
    if user is None or not verify_password(payload.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    return TokenResponse(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserRead)
def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user
