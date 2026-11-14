<?php
use App\Http\Controllers\{Admin\UserController};
use Illuminate\Support\Facades\Route;
Route::get('/admin/users/{id}', [UserController::class, 'show']);
