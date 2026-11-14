<?php
use App\Http\Controllers\Admin;
use Illuminate\Support\Facades\Route;
Route::get('/admin/users/{id}', [Admin\UserController::class, 'show']);
